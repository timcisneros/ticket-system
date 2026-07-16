function createRuntimeRunner({ runAgentTicket, markRunStarting, markRunSettled, onError = () => {} }) {
  return {
    startRun(run) {
      if (!run || !run.id) return false;
      if (typeof markRunStarting === 'function') markRunStarting(run);
      setImmediate(() => {
        void Promise.resolve()
          .then(() => runAgentTicket(run.id))
          .catch(error => onError(run, error))
          .finally(() => {
            if (typeof markRunSettled === 'function') markRunSettled(run);
          });
      });
      return true;
    }
  };
}

module.exports = {
  createRuntimeRunner
};
