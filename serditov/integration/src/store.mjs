import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { ContractError } from './contract.mjs';

export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY, source TEXT NOT NULL, event_id TEXT NOT NULL,
        entity TEXT NOT NULL, record_id TEXT NOT NULL, revision INTEGER NOT NULL,
        digest TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
        UNIQUE(source, event_id), UNIQUE(entity, record_id, revision));
      CREATE TABLE IF NOT EXISTS applied (
        entity TEXT NOT NULL, record_id TEXT NOT NULL, revision INTEGER NOT NULL,
        PRIMARY KEY(entity, record_id));`);
  }
  enqueue(event) {
    const payload = JSON.stringify(event);
    const digest = createHash('sha256').update(payload).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.db.prepare('SELECT digest FROM events WHERE source=? AND event_id=?').get(event.source, event.eventId);
      if (prior) {
        if (prior.digest !== digest) throw new ContractError('event_conflict', 409);
        this.db.exec('COMMIT');
        return false;
      }
      const revision = this.db.prepare('SELECT seq FROM events WHERE entity=? AND record_id=? AND revision=?').get(event.entity, event.recordId, event.revision);
      if (revision) throw new ContractError('revision_conflict', 409);
      this.db.prepare('INSERT INTO events(source,event_id,entity,record_id,revision,digest,payload) VALUES(?,?,?,?,?,?,?)')
        .run(event.source, event.eventId, event.entity, event.recordId, event.revision, digest, payload);
      this.db.exec('COMMIT');
      return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  next(now = Date.now()) {
    return this.db.prepare("SELECT * FROM events WHERE state='pending' AND next_at<=? ORDER BY seq LIMIT 1").get(now);
  }
  isStale(event) {
    const applied = this.db.prepare('SELECT revision FROM applied WHERE entity=? AND record_id=?').get(event.entity, event.recordId);
    return applied && applied.revision >= event.revision;
  }
  finish(row, stale = false) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!stale) this.db.prepare(`INSERT INTO applied(entity,record_id,revision) VALUES(?,?,?)
        ON CONFLICT(entity,record_id) DO UPDATE SET revision=MAX(applied.revision, excluded.revision)`)
        .run(row.entity, row.record_id, row.revision);
      this.db.prepare("UPDATE events SET state='done' WHERE seq=?").run(row.seq);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  retry(row, now = Date.now()) {
    const attempts = row.attempts + 1;
    this.db.prepare("UPDATE events SET attempts=?,next_at=? WHERE seq=?")
      .run(attempts, now + Math.min(300_000, 1000 * 2 ** Math.min(attempts, 8)), row.seq);
  }
  counts() {
    return this.db.prepare('SELECT state,COUNT(*) count FROM events GROUP BY state').all();
  }
  close() { this.db.close(); }
}
