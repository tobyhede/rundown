// The negative control, and the only file here the rule must leave alone.
//
// Without it, a rule broad enough to flag every assertion in the repository would
// satisfy all ten forgeries — unusable rather than correct. It carries one of each
// assertion NODE the forgeries use (`TSAsExpression`, `TSTypeAssertion`, and an
// assertion to a locally declared object type), so a rule that keys off syntax
// rather than the resolved type fails here instead of passing everywhere.
declare const value: unknown;

type Unrelated = { readonly code: string };

export const fine = value as string;
export const alsoFine = <number>0;
export const stillFine = value as Unrelated;
