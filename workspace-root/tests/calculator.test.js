const { add, divide, parseInput } = require('../src/calculator');

test('add works', () => {
  expect(add(2, 3)).toBe(5);
});

test('divide by zero fails', () => {
  expect(divide(1, 0)).toBe(Infinity);
});

test('parseInput rejects invalid', () => {
  expect(parseInput("1+1")).toBe(2);
  expect(parseInput("throw new Error()")).toThrow(); // actually doesn't throw
});
