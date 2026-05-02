import { GithubStarsPluginApi } from "@/api";
import { SqliteDatabase } from "@/db/sqlite";
import { Code, PluginError } from "@/errors";
import { isEmpty, isMatch, isNull, isUndefined } from "@/helpers";
import { configureLogger, logError, logInfo, resetDebugLog } from "@/logger";
import { confirm } from "@/modals";
import {
    type RepoDocMode,
    fetchRepoDocsWithConcurrency,
    selectRepoDocCandidates,
} from "@/repoDocs";
import { GithubRepositoriesService } from "@/services/github";
import { DEFAULT_SETTINGS, type PluginSettings, SettingsTab } from "@/settings";
import { StatusBar, StatusBarAction } from "@/statusBar";
import { type ImportConfig, PluginStorage } from "@/storage";
import type { GitHub } from "@/types";
import { PluginLock, getOrCreateFolder, renameFolder } from "@/utils";
import Handlebars from "handlebars";
import { DateTime } from "luxon";
import {
    type Result,
    ResultAsync,
    err,
    errAsync,
    ok,
    okAsync,
} from "neverthrow";
import { type App, Notice, Plugin, type PluginManifest } from "obsidian";

export default class GithubStarsPlugin extends Plugin {
    storage: PluginStorage;
    settings: PluginSettings = DEFAULT_SETTINGS;
    api: GithubStarsPluginApi;
    private lock = new PluginLock();
    private statusBar?: StatusBar;

    constructor(app: App, manifest: PluginManifest) {
        super(app, manifest);
        this.storage = new PluginStorage(
            new SqliteDatabase(this.app.vault.adapter),
        );
        this.api = new GithubStarsPluginApi(
            this.app.vault,
            this.app.fileManager,
        );
    }

    private get dbFolder() {
        return `${this.settings.destinationFolder}/db`;
    }

    private get repostioriesFolder() {
        return `${this.settings.destinationFolder}/repositories`;
    }

    private get archivedRepositoriesFolder() {
        return `${this.settings.destinationFolder}/unstarred`;
    }

    override async onload(): Promise<void> {
        await this.loadSettings();
        configureLogger(this.app.vault.adapter);
        this.addSettingTab(new SettingsTab(this.app, this));
        this.registerHandlebarsHelpers();
        this.statusBar = new StatusBar(this.addStatusBarItem());
        this.statusBar.updateStats(
            this.settings.stats.starredCount,
            this.settings.stats.unstarredCount,
        );

        this.addCommand({
            id: "sync-stars",
            name: "Sync starred repositories",
            callback: async () => await this.syncStars(),
        });

        this.addCommand({
            id: "fetch-missing-repo-docs",
            name: "Fetch missing repo-docs",
            callback: async () => await this.fetchRepoDocs("missing"),
        });

        this.addCommand({
            id: "refresh-stale-repo-docs",
            name: "Refresh stale repo-docs",
            callback: async () => await this.fetchRepoDocs("stale"),
        });

        this.addCommand({
            id: "refresh-all-repo-docs",
            name: "Refresh all repo-docs",
            callback: async () => {
                const isConfirmed = await confirm({
                    app: this.app,
                    title: "Refresh all repo-docs?",
                    message:
                        "This fetches repo-docs for every active public starred repository and may take several minutes.",
                    okButtonText: "Refresh",
                    cancelButtonText: "Cancel",
                });
                if (!isConfirmed) {
                    return;
                }
                return await this.fetchRepoDocs("all");
            },
        });

        this.addCommand({
            id: "recreate-repo-pages",
            name: "Recreate repo-pages locally",
            callback: async () => await this.recreateRepoPages(),
        });

        this.addCommand({
            id: "archive-unstarred-repo-pages",
            name: "Archive unstarred repo-pages",
            callback: async () => await this.archiveUnstarredRepoPages(),
        });
    }

    override async onunload(): Promise<void> {
        this.unregisterHandlebarsHelpers();
        this.storage.close();
    }

    public async loadSettings() {
        this.settings = Object.assign(
            {},
            DEFAULT_SETTINGS,
            await this.loadData(),
        );
    }

    public saveSettings(
        newSettings?: Partial<PluginSettings>,
    ): ResultAsync<void, PluginError<Code.Vault>> {
        if (!isUndefined(newSettings)) {
            if (isEmpty(newSettings) || isMatch(this.settings, newSettings)) {
                console.debug("Nothing to save");
                return okAsync();
            }

            this.settings = { ...this.settings, ...newSettings };
        }

        return ResultAsync.fromThrowable(
            (settings) => this.saveData(settings),
            () => new PluginError(Code.Vault.UnableToSaveSettings),
        )(this.settings);
    }

    private registerHandlebarsHelpers() {
        Handlebars.registerHelper(
            "dateFormat",
            (date: DateTime, format: string) => {
                return date.toFormat(format);
            },
        );
        Handlebars.registerHelper(
            "dateFormatFromMillis",
            (millis: number, format: string) => {
                return DateTime.fromMillis(millis).toFormat(format);
            },
        );
        Handlebars.registerHelper(
            "searchLanguageUrl",
            (repoUrl: URL, language: string) => {
                const searchUrl = new URL(repoUrl);
                searchUrl.pathname += "/search";
                searchUrl.searchParams.append(
                    "l",
                    language.toLowerCase().replaceAll(" ", "-"),
                );
                return searchUrl.toString();
            },
        );
    }

    private unregisterHandlebarsHelpers() {
        Handlebars.unregisterHelper("dateFormat");
        Handlebars.unregisterHelper("dateFormatFromMillis");
        Handlebars.unregisterHelper("searchLanguageUrl");
    }

    private prepareStorage(): ResultAsync<
        PluginStorage,
        PluginError<Code.Vault> | PluginError<Code.Storage>
    > {
        logInfo("prepareStorage start", {
            dbFolder: this.dbFolder,
            dbFileName: this.settings.dbFileName,
        });
        return getOrCreateFolder(this.app.vault, this.dbFolder).andThen(
            (dbFolder) =>
                this.storage
                    .init(dbFolder.path, this.settings.dbFileName)
                    .andTee(() =>
                        logInfo("prepareStorage finished", {
                            dbFolder: dbFolder.path,
                            dbFileName: this.settings.dbFileName,
                        }),
                    ),
        );
    }

    private async syncStars() {
        const config: ImportConfig = {
            fullSync: true,
            removeUnstarred: false,
            lastRepoId: undefined,
        };

        await resetDebugLog("sync-stars command started");
        logInfo("sync-stars configuration resolved", {
            fullSync: config.fullSync,
            removeUnstarred: config.removeUnstarred,
            pageSize: this.settings.pageSize,
            destinationFolder: this.settings.destinationFolder,
        });

        const result = await this.lock.run(() => {
            const doImportDataToStorage = ResultAsync.fromPromise(
                this.importDataToStorage(config),
                (error) => {
                    logError("importDataToStorage promise rejected", {
                        error: String(error),
                    });
                    return new PluginError(Code.Api.ImportFailed);
                },
            ).andThen((result) => {
                if (result.isErr()) {
                    return err(result.error);
                }
                return ok(result.value);
            });

            return this.prepareStorage()
                .andThen(() => doImportDataToStorage)
                .andThen(() => this.storage.getRepositories())
                .andThrough((repos) =>
                    this.api.restoreArchivedRepoPages(
                        this.activeRepositories(repos),
                        this.repostioriesFolder,
                        this.archivedRepositoriesFolder,
                    ),
                )
                .andThen((repos) => this.createOrUpdatePages(repos))
                .andTee(() => this.updateStats())
                .andThrough(() => this.storage.close())
                .orTee((error) => {
                    logError("sync-stars pipeline failed", {
                        code: error.code,
                        name: error.name,
                        message: error.message,
                    });
                    return error.log().notice();
                });
        });

        return result
            .andTee(() => logInfo("sync-stars command completed successfully"))
            .orTee((error) => {
                logError("sync-stars command failed", {
                    code: error.code,
                    name: error.name,
                    message: error.message,
                });
                return error.log().notice();
            });
    }

    private async recreateRepoPages() {
        const result = await this.lock.run(() => {
            return this.prepareStorage()
                .andThen((storage) => storage.getRepositories())
                .andThen((repos) => this.createOrUpdatePages(repos))
                .andTee(() => this.updateStats())
                .andThrough(() => this.storage.close())
                .orTee((error) => error.log().notice());
        });
        return result.orTee((error) => error.log().notice());
    }

    private async archiveUnstarredRepoPages() {
        const result = await this.lock.run(() => {
            return this.prepareStorage()
                .andThen((storage) => storage.getRepositories())
                .andThrough((repos) =>
                    this.api.archiveRepoPages(
                        repos.filter((repo) => Boolean(repo.unstarredAt)),
                        this.repostioriesFolder,
                        this.archivedRepositoriesFolder,
                    ),
                )
                .andThen((repos) => this.createOrUpdatePages(repos))
                .andTee(() => this.updateStats())
                .andThrough(() => this.storage.close())
                .orTee((error) => error.log().notice());
        });
        return result.orTee((error) => error.log().notice());
    }

    private async fetchRepoDocs(mode: RepoDocMode) {
        const result = await this.lock.run(() => {
            return this.prepareStorage()
                .andThen((storage) => storage.getRepositories())
                .andThen((repos) =>
                    ResultAsync.fromPromise(
                        this.fetchAndPersistRepoDocs(mode, repos),
                        () => new PluginError(Code.Api.ProcessingFailed),
                    ).andThen((result) => result),
                )
                .andThen(() => this.storage.getRepositories())
                .andThen((repos: GitHub.Repository[]) => {
                    if (!this.settings.updateRepoPagesAfterRepoDocFetch) {
                        return okAsync();
                    }
                    return this.createOrUpdatePages(repos);
                })
                .andTee(() => this.updateStats())
                .andThrough(() => this.storage.close())
                .orTee((error) => error.log().notice());
        });
        return result.orTee((error) => error.log().notice());
    }

    private async fetchAndPersistRepoDocs(
        mode: RepoDocMode,
        repos: GitHub.Repository[],
    ): Promise<Result<GitHub.Repository[], PluginError<Code.Any>>> {
        const candidates = selectRepoDocCandidates(repos, {
            mode,
            now: DateTime.utc(),
            ttlDays: this.settings.repoDocRefreshTtlDays,
        });
        const startedAt = DateTime.utc();
        logInfo("repo-doc command started", {
            mode,
            candidateCount: candidates.length,
            concurrency: this.settings.repoDocRequestConcurrency,
            ttlDays: this.settings.repoDocRefreshTtlDays,
        });
        new Notice(`Fetching repo-docs for ${candidates.length} repositories…`);

        const service = new GithubRepositoriesService(
            this.settings.accessToken,
        );
        const summary = await fetchRepoDocsWithConcurrency(
            candidates,
            this.settings.repoDocRequestConcurrency,
            async (repo) => {
                logInfo("repo-doc fetch start", {
                    repository: repo.url.toString(),
                    mode,
                });
                const repoDocResult = await service.getRepositoryReadme(
                    repo.owner.login,
                    repo.name,
                );
                if (repoDocResult.isErr()) {
                    throw repoDocResult.error;
                }
                logInfo("repo-doc fetch completed", {
                    repository: repo.url.toString(),
                    mode,
                    hasRepoDoc: Boolean(repoDocResult.value),
                    contentLength: repoDocResult.value?.length ?? 0,
                });
                return repoDocResult.value;
            },
        );

        const updateResult = await this.storage.updateRepoDocs(
            summary.successes,
        );
        if (updateResult.isErr()) {
            return err(updateResult.error);
        }

        const elapsedSeconds = DateTime.utc().diff(
            startedAt,
            "seconds",
        ).seconds;
        logInfo("repo-doc command completed", {
            mode,
            candidateCount: candidates.length,
            successCount: summary.successes.filter(
                (item) => item.status === "success",
            ).length,
            noRepoDocCount: summary.successes.filter(
                (item) => item.status === "no-repo-doc",
            ).length,
            failureCount: summary.failures.length,
            elapsedSeconds,
            candidatesPerSecond:
                candidates.length / Math.max(1, elapsedSeconds),
        });

        if (summary.failures.length) {
            new Notice(
                `Repo-doc fetch finished with ${summary.failures.length} failures. See debug.log.`,
                10000,
            );
        }

        return ok(repos);
    }

    private async importDataToStorage(
        config: ImportConfig,
    ): Promise<Result<void, PluginError<Code.Any>>> {
        const service = new GithubRepositoriesService(
            this.settings.accessToken,
        );
        logInfo("importDataToStorage start", {
            hasAccessToken: Boolean(this.settings.accessToken),
            pageSize: this.settings.pageSize,
            fullSync: config.fullSync,
        });
        const totalCountResult =
            await service.getTotalStarredRepositoriesCount();

        if (totalCountResult.isErr()) {
            logError("failed to fetch total starred repositories count", {
                code: totalCountResult.error.code,
            });
            return err(totalCountResult.error);
        }

        const totalCount = totalCountResult.value;
        logInfo("fetched total starred repositories count", { totalCount });
        new Notice(
            `Start metadata sync of ${totalCount} GitHub stars (page size is ${this.settings.pageSize} items)…`,
        );

        const statusBarAction = new StatusBarAction(
            this.statusBar as StatusBar,
            "download",
            config.fullSync ? "0%" : "",
        );
        statusBarAction.start();
        const repositoriesGen = service.getUserStarredRepositories(
            this.settings.pageSize,
        );
        const result = await this.storage.import(
            repositoriesGen,
            config,
            (count: number) => {
                if (config.fullSync) {
                    statusBarAction.updateState(
                        `${Math.floor((count / totalCount) * 100)}%`,
                    );
                }
            },
        );

        if (result.isOk()) {
            new Notice("Metadata sync of your GitHub stars was successful!");
            statusBarAction.done();
            logInfo("importDataToStorage completed", { totalCount });
        } else {
            new Notice(
                "ERROR. Metadata sync of your GitHub starred repositories failed!",
                0,
            );
            statusBarAction.failed();
            logError("importDataToStorage failed", {
                code: result.error.code,
                name: result.error.name,
                message: result.error.message,
            });
        }
        return result;
    }

    private updateStats() {
        return this.storage
            .getStats()
            .map((stats) => {
                this.settings.stats = stats;
                this.statusBar?.updateStats(
                    stats.starredCount,
                    stats.unstarredCount,
                );
            })
            .andThen(() => this.saveSettings())
            .orElse((error) => {
                console.error(error);
                return err(error);
            });
    }

    private activeRepositories(repos: GitHub.Repository[]) {
        return repos.filter((repo) => !repo.unstarredAt);
    }

    private createOrUpdatePages(repos: GitHub.Repository[]) {
        const activeRepos = this.activeRepositories(repos);
        logInfo("createOrUpdatePages start", {
            repositoryCount: activeRepos.length,
            skippedUnstarredCount: repos.length - activeRepos.length,
        });
        new Notice("Creation of pages for your GitHub stars was started…");

        const total = activeRepos.length;
        const statusBarActions: Record<string, StatusBarAction> = {
            indexByDays: new StatusBarAction(
                this.statusBar as StatusBar,
                "calendar-days",
                "",
            ),
            indexByLanguages: new StatusBarAction(
                this.statusBar as StatusBar,
                "book-a",
                "",
            ),
            indexByOwners: new StatusBarAction(
                this.statusBar as StatusBar,
                "users",
                "",
            ),
            reposPages: new StatusBarAction(
                this.statusBar as StatusBar,
                "folder-sync",
                "0%",
            ),
        };
        for (const statusBarAction of Object.values(statusBarActions)) {
            statusBarAction.start();
        }

        const pagesOfRepositories = this.api.createOrUpdateRepositoriesPages(
            activeRepos,
            this.repostioriesFolder,
            (createdPages, updatedPages) => {
                statusBarActions.reposPages.updateState(
                    `${Math.floor(((createdPages + updatedPages) / total) * 100)}%`,
                );
            },
        );
        const indexPageByDays = this.api.createOrUpdateIndexPageByDays(
            activeRepos,
            this.settings.destinationFolder,
            this.repostioriesFolder,
            this.settings.indexPageByDaysFileName,
        );
        const indexPageByLanguages =
            this.api.createOrUpdateIndexPageByLanguages(
                activeRepos,
                this.settings.destinationFolder,
                this.repostioriesFolder,
                this.settings.indexPageByLanguagesFileName,
            );
        const indexPageByOwners = this.api.createOrUpdateIndexPageByOwners(
            activeRepos,
            this.settings.destinationFolder,
            this.repostioriesFolder,
            this.settings.indexPageByOwnersFileName,
        );

        return ResultAsync.combine([
            pagesOfRepositories
                .andThen(({ createdPages, updatedPages }) => {
                    new Notice(
                        `Pages creation was finished! Created ${createdPages}, updated ${updatedPages}`,
                        10000,
                    );
                    statusBarActions.reposPages.stop().done();
                    return ok();
                })
                .orTee(() => statusBarActions.reposPages.stop().failed()),
            indexPageByDays
                .andThen(() => {
                    new Notice("Index page by dates created!");
                    statusBarActions.indexByDays.stop().done();
                    return ok();
                })
                .orTee(() => statusBarActions.indexByDays.stop().failed()),
            indexPageByLanguages
                .andThen(() => {
                    new Notice("Index page by languages created!");
                    statusBarActions.indexByLanguages.stop().done();
                    return ok();
                })
                .orTee(() => statusBarActions.indexByLanguages.stop().failed()),
            indexPageByOwners
                .andThen(() => {
                    new Notice("Index page by owners created!");
                    statusBarActions.indexByOwners.stop().done();
                    return ok();
                })
                .orTee(() => statusBarActions.indexByOwners.stop().failed()),
        ])
            .andThen(() => ok())
            .andTee(() =>
                logInfo("createOrUpdatePages completed", {
                    repositoryCount: activeRepos.length,
                }),
            )
            .orTee((error) => {
                logError("createOrUpdatePages failed", {
                    code: error.code,
                    name: error.name,
                    message: error.message,
                });
                return error.log().notice();
            });
    }

    private renameDestinationFolder(
        oldPath: string,
        newPath: string,
    ): ResultAsync<string, PluginError<Code.Vault>> {
        const isNewDestinationFolderExists = !isNull(
            this.app.vault.getFolderByPath(newPath),
        );
        if (isNewDestinationFolderExists) {
            return errAsync(
                new PluginError(Code.Vault.NewDestinationFolderIsExists),
            );
        }
        const currentDestinationFolder =
            this.app.vault.getFolderByPath(oldPath);
        if (isNull(currentDestinationFolder)) {
            return errAsync(
                new PluginError(Code.Vault.UnableToRenameDestinationFolder),
            );
        }

        return renameFolder(
            this.app.vault,
            currentDestinationFolder,
            newPath,
        ).map(() => newPath);
    }

    public async updateSettings(settings: Partial<PluginSettings>) {
        const oldSettings = structuredClone(this.settings);
        const result = await this.lock.run(() => {
            return this.saveSettings(settings).andThrough(() => {
                if (
                    isUndefined(settings.destinationFolder) ||
                    settings.destinationFolder === oldSettings.destinationFolder
                ) {
                    return okAsync();
                }
                return this.renameDestinationFolder(
                    oldSettings.destinationFolder,
                    settings.destinationFolder,
                );
            });
        });
        return result.orTee((error) => error.log().notice());
    }
}
