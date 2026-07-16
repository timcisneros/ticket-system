function createRuntimeRunner({ runAgentTicket, markRunStarting, onError = () => {}, onSettled = () => {} }) {
  return {
    startRun(run, admission = null) {
      if (!run || !run.id) return false;
      if (typeof markRunStarting === 'function') markRunStarting(run);
      setImmediate(() => {
        void Promise.resolve()
          .then(() => runAgentTicket(run.id, admission))
          .catch(error => onError(run, error))
          .finally(() => onSettled(run, admission));
      });
      return true;
    }
  };
}

module.exports = {
  createRuntimeRunner
};
