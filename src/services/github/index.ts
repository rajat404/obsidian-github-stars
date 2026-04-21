import { Code, PluginError } from "@/errors";
import { Octokit } from "@octokit/core";
import { retry } from "@octokit/plugin-retry";
import { type Result, ResultAsync } from "neverthrow";
import starredRepositoriesQuery from "./queries/starredRepositories.gql";
import totalStarredRepositoriesCountQuery from "./queries/totalStarredRepositoriesCount.gql";
import type { GitHubGraphQl, GitHubRest } from "./types";

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
    client: Octokit;

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
    client: Octokit;
    publicClient: Octokit;

    constructor(accessToken: string) {
        this.accessToken = accessToken;
        const OctokitWithRetries = Octokit.plugin(retry);
        this.client = new OctokitWithRetries({
            auth: this.accessToken,
            request: { retries: 1, retryAfter: 1 },
        });
        this.publicClient = new OctokitWithRetries({
            request: { retries: 1, retryAfter: 1 },
        });
    }

    private getOnePageOfStarredRepos(
        after: string,
        pageSize: number,
    ): ResultAsync<
        StarredRepositoriesQueryResult,
        PluginError<Code.GithubService>
    > {
        const makeRequest = ResultAsync.fromPromise(
            this.client.graphql<GitHubGraphQl.StarredRepositoriesResponse>(
                starredRepositoriesQuery,
                {
                    after,
                    pageSize,
                },
            ),
            () => new PluginError(Code.GithubService.RequestFailed),
        );

        return makeRequest.map((response) => {
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
        let totalFetched = 0;
        do {
            const requestResult = await this.getOnePageOfStarredRepos(
                after,
                pageSize,
            );
            const result = requestResult.map((data) => {
                hasNextPage = data.hasNextPage;
                after = data.endCursor ? data.endCursor : "";
                totalFetched += data.repositories.length;
                return data.repositories;
            });
            yield result;
        } while (hasNextPage);
    }

    public getTotalStarredRepositoriesCount(): ResultAsync<
        number,
        PluginError<Code.GithubService>
    > {
        return ResultAsync.fromPromise(
            this.client.graphql<GitHubGraphQl.StarredRepositoriesResponse>(
                totalStarredRepositoriesCountQuery,
            ),
            () => new PluginError(Code.GithubService.RequestFailed),
        ).map((response) => response.viewer.starredRepositories.totalCount);
    }

    public getRepositoryReadme(
        owner: string,
        repo: string,
    ): ResultAsync<string | undefined, PluginError<Code.GithubService>> {
        const request = (async () => {
            try {
                const response = await this.publicClient.request(
                    "GET /repos/{owner}/{repo}/readme",
                    {
                        owner,
                        repo,
                        headers: {
                            accept: "application/vnd.github+json",
                        },
                    },
                );
                const data = response.data as GitHubRest.ReadmeResponse;

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
            } catch (error) {
                if (
                    error instanceof Error &&
                    "status" in error &&
                    error.status === 404
                ) {
                    return undefined;
                }
                throw error;
            }
        })();

        return ResultAsync.fromPromise(
            request,
            () => new PluginError(Code.GithubService.RequestFailed),
        );
    }
}
