import { Code, PluginError } from "@/errors";
import { logWarn } from "@/logger";
import { type Result, ResultAsync } from "neverthrow";
import { requestUrl } from "obsidian";
import starredRepositoriesQuery from "./queries/starredRepositories.gql";
import totalStarredRepositoriesCountQuery from "./queries/totalStarredRepositoriesCount.gql";
import type { GitHubGraphQl, GitHubRest } from "./types";

const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
const GITHUB_API_URL = "https://api.github.com";
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 5;

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

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
            const response = await requestUrl({
                url: request.url,
                method: request.method,
                headers: this.headers,
                body: request.body,
                throw: false,
            });
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
                status: response.status,
                attempt,
                backoffMs,
            });
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }

        return lastResponse;
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
        do {
            const requestResult = await this.getOnePageOfStarredRepos(
                after,
                pageSize,
            );
            const result = requestResult.map((data) => {
                hasNextPage = data.hasNextPage;
                after = data.endCursor ? data.endCursor : "";
                return data.repositories;
            });
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
                const response = await this.requestWithRetry({
                    url: `${GITHUB_API_URL}/repos/${owner}/${repo}/readme`,
                    method: "GET",
                });

                if (!response) {
                    throw new Error(
                        "GitHub README request returned no response",
                    );
                }

                if (response.status === 404) {
                    return undefined;
                }

                if (response.status >= 400) {
                    logWarn("GitHub README request failed", {
                        owner,
                        repo,
                        status: response.status,
                        body: response.text.slice(0, 500),
                    });
                    throw new Error(`GitHub README HTTP ${response.status}`);
                }

                const data = response.json as GitHubRest.ReadmeResponse;
                if (!data.content) {
                    return undefined;
                }

                if (data.encoding === "base64") {
                    return Buffer.from(
                        data.content.replaceAll("\n", ""),
                        "base64",
                    ).toString("utf-8");
                }

                return data.content;
            })(),
            () => new PluginError(Code.GithubService.RequestFailed),
        );
    }
}
