export type AutomaticVerificationStrength =
  | "structural_only"
  | "deterministic_oracle";

export type VerificationStrength =
  | AutomaticVerificationStrength
  | "human_adjudicated";
