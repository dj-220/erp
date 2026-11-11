/** Units seeded for every new company. `uqc` is the GST Unit Quantity Code used on e-invoices. */
export const DEFAULT_UOMS: readonly { code: string; name: string; uqc: string; decimals: number }[] = [
  { code: "NOS", name: "Numbers", uqc: "NOS", decimals: 0 },
  { code: "PCS", name: "Pieces", uqc: "PCS", decimals: 0 },
  { code: "PRS", name: "Pairs", uqc: "PRS", decimals: 0 },
  { code: "SET", name: "Sets", uqc: "SET", decimals: 0 },
  { code: "BOX", name: "Boxes", uqc: "BOX", decimals: 0 },
  { code: "PAC", name: "Packs", uqc: "PAC", decimals: 0 },
  { code: "BAG", name: "Bags", uqc: "BAG", decimals: 0 },
  { code: "CTN", name: "Cartons", uqc: "CTN", decimals: 0 },
  { code: "BTL", name: "Bottles", uqc: "BTL", decimals: 0 },
  { code: "ROL", name: "Rolls", uqc: "ROL", decimals: 0 },
  { code: "DOZ", name: "Dozens", uqc: "DOZ", decimals: 3 },
  { code: "KGS", name: "Kilograms", uqc: "KGS", decimals: 3 },
  { code: "GMS", name: "Grams", uqc: "GMS", decimals: 3 },
  { code: "QTL", name: "Quintals", uqc: "QTL", decimals: 3 },
  { code: "TON", name: "Tonnes", uqc: "TON", decimals: 3 },
  { code: "MTR", name: "Metres", uqc: "MTR", decimals: 3 },
  { code: "CMS", name: "Centimetres", uqc: "CMS", decimals: 3 },
  { code: "SQM", name: "Square metres", uqc: "SQM", decimals: 3 },
  { code: "SQF", name: "Square feet", uqc: "SQF", decimals: 3 },
  { code: "LTR", name: "Litres", uqc: "LTR", decimals: 3 },
  { code: "MLT", name: "Millilitres", uqc: "MLT", decimals: 3 },
  { code: "OTH", name: "Others", uqc: "OTH", decimals: 3 },
];

/** Locations outside any warehouse, so each stock movement can be a balanced transfer. */
export const VIRTUAL_LOCATIONS = [
  { name: "Vendors", kind: "supplier" },
  { name: "Customers", kind: "customer" },
  { name: "Production", kind: "production" },
  { name: "Inventory adjustment", kind: "adjustment" },
  { name: "In transit", kind: "transit" },
] as const;
