function createRuntimeRunner({ runAgentTicket, markRunStarting, onError = () => {} }) {
  return {
    startRun(run) {
      if (!run || !run.id) return false;
      if (typeof markRunStarting === 'function') markRunStarting(run);
      setImmediate(() => {
        void Promise.resolve()
          .then(() => runAgentTicket(run.id))
          .catch(error => onError(run, error));
      });
      return true;
    }
  };
}

module.exports = {
  createRuntimeRunner
};
