import { formatUnits, parseU128, parseUnits } from "@/lib/format/units";

test("formats without floats, even above 2^53", () => {
  expect(formatUnits(1234567n, 6)).toBe("1.234567");
  expect(formatUnits(1_000_000n, 6)).toBe("1");
  expect(formatUnits(1999n, 3, 2)).toBe("1.99");
  expect(formatUnits(5n, 6)).toBe("0.000005");
  expect(formatUnits(0n, 6)).toBe("0");
  expect(formatUnits(2n ** 127n, 6)).toBe("170141183460469231731687303715884.105728");
});
test("formats negative values for deltas", () => {
  expect(formatUnits(-1_500_000n, 6)).toBe("-1.5");
});
test("parses exactly and refuses extra precision", () => {
  expect(parseUnits("12.5", 6)).toBe(12_500_000n);
  expect(parseUnits("7", 6)).toBe(7_000_000n);
  expect(() => parseUnits("1.0000001", 6)).toThrow();
  expect(() => parseUnits("1e3", 6)).toThrow();
  expect(() => parseUnits("", 6)).toThrow();
  expect(() => parseUnits("-1", 6)).toThrow();
});
test("U128 only accepts decimal strings in range", () => {
  expect(parseU128("340282366920938463463374607431768211455")).toBe(2n ** 128n - 1n);
  expect(() => parseU128(12)).toThrow();
  expect(() => parseU128("0x10")).toThrow();
  expect(() => parseU128((2n ** 128n).toString())).toThrow();
});
