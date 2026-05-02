import { describe, expect, test } from "bun:test";
import { DateTime } from "luxon";
import {
    fetchRepoDocsWithConcurrency,
    selectRepoDocCandidates,
} from "./repoDocs";
import { GitHub } from "./types";

function repo(
    id: string,
    data: Partial<GitHub.Repository> = {},
): GitHub.Repository {
    return new GitHub.Repository({
        id,
        name: id,
        url: new URL(`https://github.com/example/${id}`),
        owner: {
            login: "example",
            url: new URL("https://github.com/example"),
            isOrganization: false,
        },
        createdAt: DateTime.utc(2024, 1, 1),
        pushedAt: DateTime.utc(2024, 1, 1),
        starredAt: DateTime.utc(2024, 1, 1),
        updatedAt: DateTime.utc(2024, 1, 1),
        importedAt: DateTime.utc(2024, 1, 1),
        ...data,
    });
}

describe("selectRepoDocCandidates", () => {
    test("missing mode selects only active never-fetched public repositories", () => {
        const now = DateTime.utc(2026, 5, 2);
        const candidates = selectRepoDocCandidates(
            [
                repo("never-fetched", {
                    starredAt: DateTime.utc(2026, 1, 3),
                }),
                repo("confirmed-no-doc", {
                    readmeFetchedAt: DateTime.utc(2026, 1, 2),
                }),
                repo("private", { isPrivate: true }),
                repo("unstarred", { unstarredAt: DateTime.utc(2026, 1, 1) }),
            ],
            { mode: "missing", now, ttlDays: 30 },
        );

        expect(candidates.map((candidate) => candidate.id)).toEqual([
            "never-fetched",
        ]);
    });

    test("stale mode orders never-fetched first, then stale newest stars", () => {
        const now = DateTime.utc(2026, 5, 2);
        const candidates = selectRepoDocCandidates(
            [
                repo("stale-older-star", {
                    readmeFetchedAt: DateTime.utc(2026, 3, 1),
                    starredAt: DateTime.utc(2025, 1, 1),
                }),
                repo("fresh", {
                    readmeFetchedAt: DateTime.utc(2026, 4, 20),
                    starredAt: DateTime.utc(2026, 1, 1),
                }),
                repo("never-fetched", {
                    starredAt: DateTime.utc(2026, 2, 1),
                }),
                repo("stale-newer-star", {
                    readmeFetchedAt: DateTime.utc(2026, 2, 1),
                    starredAt: DateTime.utc(2026, 1, 5),
                }),
            ],
            { mode: "stale", now, ttlDays: 30 },
        );

        expect(candidates.map((candidate) => candidate.id)).toEqual([
            "never-fetched",
            "stale-newer-star",
            "stale-older-star",
        ]);
    });

    test("all mode selects every active public repository", () => {
        const now = DateTime.utc(2026, 5, 2);
        const candidates = selectRepoDocCandidates(
            [
                repo("active"),
                repo("private", { isPrivate: true }),
                repo("unstarred", { unstarredAt: DateTime.utc(2026, 1, 1) }),
            ],
            { mode: "all", now, ttlDays: 30 },
        );

        expect(candidates.map((candidate) => candidate.id)).toEqual(["active"]);
    });
});

describe("fetchRepoDocsWithConcurrency", () => {
    test("continues after per-repository failures and records no-repo-doc state", async () => {
        const fetchedAt = DateTime.utc(2026, 5, 2);
        const summary = await fetchRepoDocsWithConcurrency(
            [repo("with-doc"), repo("without-doc"), repo("failed")],
            2,
            async (candidate) => {
                if (candidate.id === "failed") {
                    throw new Error("boom");
                }

                if (candidate.id === "without-doc") {
                    return undefined;
                }

                return "# Repo doc";
            },
            fetchedAt,
        );

        expect(summary.successes).toHaveLength(2);
        expect(summary.failures.map((failure) => failure.repo.id)).toEqual([
            "failed",
        ]);
        expect(
            summary.successes.find((item) => item.repo.id === "without-doc")
                ?.status,
        ).toBe("no-repo-doc");
        expect(
            summary.successes.every((item) => item.fetchedAt === fetchedAt),
        ).toBe(true);
    });
});
