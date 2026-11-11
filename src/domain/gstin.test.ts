import { describe, expect, it } from "vitest";
import { gstinChecksumChar, isValidGstin, parseGstin } from "./gstin";

describe("GSTIN checksum", () => {
  it("matches a commonly cited sample GSTIN", () => {
    // A sample number seen in GST documentation and tutorials (from memory, not an official
    // source): the algorithm reproducing its check character corroborates both. Verify any
    // real GSTIN against the GST portal; offline validation proves shape, not that it is active.
    expect(gstinChecksumChar("27AAPFU0939F1Z")).toBe("V");
    expect(isValidGstin("27AAPFU0939F1ZV")).toBe(true);
  });

  it("accepts any body with its computed check character, and rejects every single-character change", () => {
    const bodies = ["29ABCDE1234F1Z", "07AAACR5055K1Z", "33BBBBB9999B1Z", "24AAAAA0000A1Z"];
    const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    for (const body of bodies) {
      const gstin = body + gstinChecksumChar(body);
      expect(parseGstin(gstin).valid).toBe(true);
      // Changing the check character to any other value must fail.
      for (const c of alphabet) {
        if (c === gstin[14]) continue;
        expect(isValidGstin(gstin.slice(0, 14) + c)).toBe(false);
      }
    }
  });

  it("is case and whitespace tolerant, and reports parts", () => {
    const body = "29ABCDE1234F1Z";
    const gstin = body + gstinChecksumChar(body);
    const parsed = parseGstin(`  ${gstin.toLowerCase()} `);
    expect(parsed).toEqual({
      valid: true,
      gstin,
      stateCode: "29",
      pan: "ABCDE1234F",
      entityNumber: "1",
    });
  });
});

describe("GSTIN rejections", () => {
  it("gives a reason", () => {
    expect(parseGstin("27AAPFU0939F1Z")).toEqual({ valid: false, reason: "LENGTH" });
    expect(parseGstin("27AAPFU0939F1XV")).toEqual({ valid: false, reason: "FORMAT" });
    expect(parseGstin("2AAAPFU0939F1ZV")).toEqual({ valid: false, reason: "FORMAT" });
    expect(parseGstin("27AAPFU0939F1ZW")).toEqual({ valid: false, reason: "CHECKSUM" });
    const noSuchState = "00AAPFU0939F1Z";
    expect(parseGstin(noSuchState + gstinChecksumChar(noSuchState))).toEqual({
      valid: false,
      reason: "STATE",
    });
  });
});
