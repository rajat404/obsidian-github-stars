import type { GitHub } from "@/types";
import { DateTime } from "luxon";

export type RepoDocMode = "missing" | "stale" | "all";

export type RepoDocCandidateOptions = {
    mode: RepoDocMode;
    now: DateTime;
    ttlDays: number;
};

export type RepoDocFetchResult = {
    repo: GitHub.Repository;
    readme?: string;
    fetchedAt: DateTime;
    status: "success" | "no-repo-doc";
};

export type RepoDocFetchFailure = {
    repo: GitHub.Repository;
    error: unknown;
};

export type RepoDocFetchSummary = {
    successes: RepoDocFetchResult[];
    failures: RepoDocFetchFailure[];
};

export function selectRepoDocCandidates(
    repositories: GitHub.Repository[],
    options: RepoDocCandidateOptions,
): GitHub.Repository[] {
    const cutoff = options.now.minus({ days: options.ttlDays });

    return repositories
        .filter((repo) => !repo.isPrivate)
        .filter((repo) => !repo.unstarredAt)
        .filter((repo) => {
            if (options.mode === "all") {
                return true;
            }

            if (!repo.readmeFetchedAt) {
                return true;
            }

            if (options.mode === "stale") {
                return repo.readmeFetchedAt < cutoff;
            }

            return false;
        })
        .sort((lhs, rhs) => {
            const lhsNeverFetched = lhs.readmeFetchedAt ? 1 : 0;
            const rhsNeverFetched = rhs.readmeFetchedAt ? 1 : 0;
            if (lhsNeverFetched !== rhsNeverFetched) {
                return lhsNeverFetched - rhsNeverFetched;
            }

            return (
                (rhs.starredAt?.toMillis() ?? 0) -
                (lhs.starredAt?.toMillis() ?? 0)
            );
        });
}

export async function fetchRepoDocsWithConcurrency(
    repositories: GitHub.Repository[],
    concurrency: number,
    fetchRepoDoc: (repo: GitHub.Repository) => Promise<string | undefined>,
    fetchedAt: DateTime = DateTime.utc(),
): Promise<RepoDocFetchSummary> {
    const successes: RepoDocFetchResult[] = [];
    const failures: RepoDocFetchFailure[] = [];
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < repositories.length) {
            const repo = repositories[nextIndex];
            nextIndex += 1;

            try {
                const readme = await fetchRepoDoc(repo);
                successes.push({
                    repo,
                    readme,
                    fetchedAt,
                    status: readme ? "success" : "no-repo-doc",
                });
            } catch (error) {
                failures.push({ repo, error });
            }
        }
    }

    const workerCount = Math.max(1, Math.min(concurrency, repositories.length));
    await Promise.all(
        Array.from({ length: workerCount }, async () => await worker()),
    );

    return { successes, failures };
}
