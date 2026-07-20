'use strict';

class PostgresSessionStore {
  constructor(runtimeStore, { defaultTtlMs = 24 * 60 * 60 * 1000 } = {}) {
    if (!runtimeStore || typeof runtimeStore.getHttpSession !== 'function') throw new TypeError('runtimeStore with HTTP session methods is required');
    this.runtimeStore = runtimeStore;
    this.defaultTtlMs = defaultTtlMs;
  }

  _expiresAt(session) {
    const cookieExpiry = session && session.cookie && session.cookie.expires;
    const parsed = cookieExpiry ? new Date(cookieExpiry) : null;
    return parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date(Date.now() + this.defaultTtlMs);
  }

  get(sessionId, callback) {
    this.runtimeStore.getHttpSession(sessionId).then(session => callback(null, session || null), callback);
  }

  set(sessionId, session, callback) {
    this.runtimeStore.setHttpSession({ sid: sessionId, session, expiresAt: this._expiresAt(session) }).then(() => callback && callback(null), error => callback && callback(error));
  }

  destroy(sessionId, callback) {
    this.runtimeStore.deleteHttpSession(sessionId).then(() => callback && callback(null), error => callback && callback(error));
  }

  touch(sessionId, session, callback) {
    this.runtimeStore.touchHttpSession({ sid: sessionId, expiresAt: this._expiresAt(session) }).then(() => callback && callback(null), error => callback && callback(error));
  }
}

module.exports = { PostgresSessionStore };
