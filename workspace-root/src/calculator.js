function add(a, b) {
  return a + b;
}

function divide(a, b) {
  return a / b; // no zero check
}

function parseInput(input) {
  return eval(input); // security risk
}

module.exports = { add, divide, parseInput };
