import { Code, PluginError } from "@/errors";
import { logInfo, logWarn } from "@/logger";
import { type Result, ResultAsync } from "neverthrow";
import { requestUrl } from "obsidian";
import starredRepositoriesQuery from "./queries/starredRepositories.gql";
import totalStarredRepositoriesCountQuery from "./queries/totalStarredRepositoriesCount.gql";
import type { GitHubGraphQl, GitHubRest } from "./types";

const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
const GITHUB_API_URL = "https://api.github.com";
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 5;
const REQUEST_TIMEOUT_MS = 30_000;

export interface StarredRepositoriesQueryResult {
    repositories: GitHubGraphQl.StarredRepositoryEdge[];
    totalCount: number;
    hasNextPage: boolean;
    endCursor?: string;
}

export type StarredRepositoriesGenerator = AsyncGenerator<
    Result<
        GitHubGraphQl.StarredRepositoryEdge[],
        PluginError<Code.GithubService>
    >,
    void,
    unknown
>;

export interface IGithubRepositoriesService {
    accessToken: string;

    getUserStarredRepositories(pageSize: number): StarredRepositoriesGenerator;
    getRepositoryReadme(
        owner: string,
        repo: string,
    ): ResultAsync<string | undefined, PluginError<Code.GithubService>>;

    getTotalStarredRepositoriesCount(): ResultAsync<
        number,
        PluginError<Code.GithubService>
    >;
}

export class GithubRepositoriesService implements IGithubRepositoriesService {
    accessToken: string;

    constructor(accessToken: string) {
        this.accessToken = accessToken;
    }

    private get headers(): Record<string, string> {
        return {
            Authorization: `Bearer ${this.accessToken}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
        };
    }

    private async requestWithRetry(request: {
        url: string;
        method: "GET" | "POST";
        body?: string;
    }) {
        let lastResponse: Awaited<ReturnType<typeof requestUrl>> | undefined;
        let lastError: unknown;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
            let response: Awaited<ReturnType<typeof requestUrl>>;
            try {
                response = await this.withTimeout(
                    requestUrl({
                        url: request.url,
                        method: request.method,
                        headers: this.headers,
                        body: request.body,
                        throw: false,
                    }),
                    REQUEST_TIMEOUT_MS,
                );
            } catch (error) {
                lastError = error;

                if (attempt === MAX_RETRIES) {
                    throw error;
                }

                const backoffMs = 1000 * 2 ** (attempt - 1);
                logWarn("GitHub request failed before response; retrying", {
                    url: request.url,
                    method: request.method,
                    attempt,
                    backoffMs,
                    error: String(error),
                });
                await this.sleep(backoffMs);
                continue;
            }

            lastResponse = response;

            if (!RETRYABLE_STATUS_CODES.has(response.status)) {
                return response;
            }

            if (attempt === MAX_RETRIES) {
                return response;
            }

            const retryAfterSeconds = Number.parseInt(
                response.headers["retry-after"] ?? "",
                10,
            );
            const backoffMs = Number.isFinite(retryAfterSeconds)
                ? retryAfterSeconds * 1000
                : 1000 * 2 ** (attempt - 1);

            logWarn("GitHub request retry scheduled", {
                url: request.url,
                method: request.method,
                status: response.status,
                attempt,
                backoffMs,
            });
            await this.sleep(backoffMs);
        }

        if (lastError) {
            throw lastError;
        }

        return lastResponse;
    }

    private async withTimeout<T>(
        promise: Promise<T>,
        timeoutMs: number,
    ): Promise<T> {
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => {
                reject(
                    new Error(`GitHub request timed out after ${timeoutMs}ms`),
                );
            }, timeoutMs);
        });

        try {
            return await Promise.race([promise, timeoutPromise]);
        } finally {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    private graphqlRequest<T>(
        query: string,
        variables?: Record<string, unknown>,
    ): ResultAsync<T, PluginError<Code.GithubService>> {
        return ResultAsync.fromPromise(
            (async () => {
                const response = await this.requestWithRetry({
                    url: GITHUB_GRAPHQL_URL,
                    method: "POST",
                    body: JSON.stringify({ query, variables }),
                });

                if (!response) {
                    throw new Error(
                        "GitHub GraphQL request returned no response",
                    );
                }

                if (response.status >= 400) {
                    logWarn("GitHub GraphQL request failed", {
                        status: response.status,
                        body: response.text.slice(0, 500),
                    });
                    throw new Error(`GitHub GraphQL HTTP ${response.status}`);
                }

                const payload = response.json as
                    | { data?: T; errors?: unknown[] }
                    | undefined;

                if (!payload?.data || payload.errors?.length) {
                    logWarn("GitHub GraphQL response contained errors", {
                        errors: payload?.errors ?? [],
                    });
                    throw new Error("GitHub GraphQL response contained errors");
                }

                return payload.data;
            })(),
            () => new PluginError(Code.GithubService.RequestFailed),
        );
    }

    private getOnePageOfStarredRepos(
        after: string,
        pageSize: number,
    ): ResultAsync<
        StarredRepositoriesQueryResult,
        PluginError<Code.GithubService>
    > {
        return this.graphqlRequest<GitHubGraphQl.StarredRepositoriesResponse>(
            starredRepositoriesQuery,
            {
                after,
                pageSize,
            },
        ).map((response) => {
            return {
                repositories: response.viewer.starredRepositories.edges,
                totalCount: response.viewer.starredRepositories.totalCount,
                hasNextPage:
                    response.viewer.starredRepositories.pageInfo.hasNextPage,
                endCursor:
                    response.viewer.starredRepositories.pageInfo.endCursor,
            };
        });
    }

    public async *getUserStarredRepositories(
        pageSize: number,
    ): StarredRepositoriesGenerator {
        let after = "";
        let hasNextPage = false;
        let page = 0;
        do {
            page += 1;
            logInfo("GitHub starred repositories page request start", {
                page,
                pageSize,
                hasCursor: Boolean(after),
            });
            const requestResult = await this.getOnePageOfStarredRepos(
                after,
                pageSize,
            );
            const result = requestResult.map((data) => {
                hasNextPage = data.hasNextPage;
                after = data.endCursor ? data.endCursor : "";
                logInfo("GitHub starred repositories page request completed", {
                    page,
                    receivedCount: data.repositories.length,
                    totalCount: data.totalCount,
                    hasNextPage: data.hasNextPage,
                    hasEndCursor: Boolean(data.endCursor),
                });
                return data.repositories;
            });
            if (result.isErr()) {
                logWarn("GitHub starred repositories page request failed", {
                    page,
                    code: result.error.code,
                });
            }
            yield result;
        } while (hasNextPage);
    }

    public getTotalStarredRepositoriesCount(): ResultAsync<
        number,
        PluginError<Code.GithubService>
    > {
        return this.graphqlRequest<GitHubGraphQl.StarredRepositoriesResponse>(
            totalStarredRepositoriesCountQuery,
        ).map((response) => response.viewer.starredRepositories.totalCount);
    }

    public getRepositoryReadme(
        owner: string,
        repo: string,
    ): ResultAsync<string | undefined, PluginError<Code.GithubService>> {
        return ResultAsync.fromPromise(
            (async () => {
                logInfo("GitHub repo-doc request start", { owner, repo });
                const response = await this.requestWithRetry({
                    url: `${GITHUB_API_URL}/repos/${owner}/${repo}/readme`,
                    method: "GET",
                });

                if (!response) {
                    throw new Error(
                        "GitHub repo-doc request returned no response",
                    );
                }

                if (response.status === 404) {
                    logInfo("GitHub repo-doc not found", { owner, repo });
                    return undefined;
                }

                if (response.status >= 400) {
                    logWarn("GitHub repo-doc request failed", {
                        owner,
                        repo,
                        status: response.status,
                        body: response.text.slice(0, 500),
                    });
                    throw new Error(`GitHub repo-doc HTTP ${response.status}`);
                }

                const data = response.json as GitHubRest.ReadmeResponse;
                if (!data.content) {
                    logInfo("GitHub repo-doc response had no content", {
                        owner,
                        repo,
                        status: response.status,
                    });
                    return undefined;
                }

                if (data.encoding === "base64") {
                    const decoded = Buffer.from(
                        data.content.replaceAll("\n", ""),
                        "base64",
                    ).toString("utf-8");
                    logInfo("GitHub repo-doc request completed", {
                        owner,
                        repo,
                        status: response.status,
                        encoding: data.encoding,
                        contentLength: decoded.length,
                    });
                    return decoded;
                }

                logInfo("GitHub repo-doc request completed", {
                    owner,
                    repo,
                    status: response.status,
                    encoding: data.encoding,
                    contentLength: data.content.length,
                });
                return data.content;
            })(),
            () => new PluginError(Code.GithubService.RequestFailed),
        );
    }
}
