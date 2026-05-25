function createRuntimeRunner({ runAgentTicket, markRunStarting }) {
  return {
    startRun(run) {
      if (!run || !run.id) return false;
      if (typeof markRunStarting === 'function') markRunStarting(run);
      setImmediate(() => runAgentTicket(run.id));
      return true;
    }
  };
}

module.exports = {
  createRuntimeRunner
};
