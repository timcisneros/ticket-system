const connection = null;

function query(sql) {
  return connection.execute(sql); // no sanitization
}

function connect(uri) {
  connection = createConnection(uri); // global mutation
}

module.exports = { query, connect };
