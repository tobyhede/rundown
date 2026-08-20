// The negative control, and the only file here the rule must leave alone.
//
// Without it, a rule broad enough to flag every assertion in the repository would
// satisfy all ten forgeries — unusable rather than correct. It carries one of each
// assertion NODE the forgeries use (`TSAsExpression`, `TSTypeAssertion`, and an
// assertion to a locally declared object type), so a rule that keys off syntax
// rather than the resolved type fails here instead of passing everywhere.
declare const value: unknown;

type Unrelated = { readonly code: string };

/** An `as` assertion to an unrelated built-in. The ban must not fire. */
export const fine = value as string;
/** An angle-bracket assertion to an unrelated built-in. The ban must not fire. */
export const alsoFine = <number>0;
/** An assertion to a locally declared object type. The ban must not fire. */
export const stillFine = value as Unrelated;
