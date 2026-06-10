SELECT (
    SELECT COUNT(id)
    FROM repositories
    WHERE unstarredAt IS NULL
  ) AS starredCount,
  (
    SELECT COUNT(id)
    FROM repositories
    WHERE unstarredAt IS NOT NULL
  ) AS unstarredCount,
  (
    SELECT id
    FROM repositories
    WHERE unstarredAt IS NULL
    ORDER BY starredAt DESC
    LIMIT 1
  ) AS lastRepoId;
