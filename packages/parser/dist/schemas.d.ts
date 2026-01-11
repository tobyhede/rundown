import { z } from 'zod';
/**
 * Maximum valid step number (prevent overflow, keep IDs reasonable)
 */
export declare const MAX_STEP_NUMBER = 999999;
/**
 * Zod schema for Command
 */
export declare const CommandSchema: z.ZodObject<{
    code: z.ZodString;
}, "strip", z.ZodTypeAny, {
    code: string;
}, {
    code: string;
}>;
/**
 * Zod schema for StepNumber branded type
 */
export declare const StepNumberSchema: z.ZodBranded<z.ZodNumber, "StepNumber">;
/**
 * StepNumber type derived from schema
 */
export type StepNumber = z.output<typeof StepNumberSchema>;
/**
 * Schema for named step identifiers
 * Validates format and rejects reserved words (uses RESERVED_WORDS from step-id.ts)
 */
export declare const NamedIdentifierSchema: z.ZodEffects<z.ZodString, string, string>;
/**
 * Zod schema for StepId
 */
export declare const StepIdSchema: z.ZodEffects<z.ZodObject<{
    step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
    substep: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    step: string | (number & z.BRAND<"StepNumber">);
    substep?: string | undefined;
}, {
    step: string | number;
    substep?: string | undefined;
}>, {
    step: string | (number & z.BRAND<"StepNumber">);
    substep?: string | undefined;
}, {
    step: string | number;
    substep?: string | undefined;
}>;
/**
 * StepId type derived from schema
 */
export type StepId = Readonly<z.output<typeof StepIdSchema>>;
/**
 * Non-recursive action types
 */
export declare const NonRetryActionSchema: z.ZodUnion<[z.ZodObject<{
    type: z.ZodLiteral<"CONTINUE">;
}, "strip", z.ZodTypeAny, {
    type: "CONTINUE";
}, {
    type: "CONTINUE";
}>, z.ZodObject<{
    type: z.ZodLiteral<"COMPLETE">;
    message: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "COMPLETE";
    message?: string | undefined;
}, {
    type: "COMPLETE";
    message?: string | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"STOP">;
    message: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "STOP";
    message?: string | undefined;
}, {
    type: "STOP";
    message?: string | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"GOTO">;
    target: z.ZodEffects<z.ZodObject<{
        step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
        substep: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        step: string | (number & z.BRAND<"StepNumber">);
        substep?: string | undefined;
    }, {
        step: string | number;
        substep?: string | undefined;
    }>, {
        step: string | (number & z.BRAND<"StepNumber">);
        substep?: string | undefined;
    }, {
        step: string | number;
        substep?: string | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    type: "GOTO";
    target: {
        step: string | (number & z.BRAND<"StepNumber">);
        substep?: string | undefined;
    };
}, {
    type: "GOTO";
    target: {
        step: string | number;
        substep?: string | undefined;
    };
}>]>;
export type NonRetryAction = Readonly<z.output<typeof NonRetryActionSchema>>;
/**
 * Zod schema for Action
 */
export declare const ActionSchema: z.ZodUnion<[z.ZodUnion<[z.ZodObject<{
    type: z.ZodLiteral<"CONTINUE">;
}, "strip", z.ZodTypeAny, {
    type: "CONTINUE";
}, {
    type: "CONTINUE";
}>, z.ZodObject<{
    type: z.ZodLiteral<"COMPLETE">;
    message: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "COMPLETE";
    message?: string | undefined;
}, {
    type: "COMPLETE";
    message?: string | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"STOP">;
    message: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "STOP";
    message?: string | undefined;
}, {
    type: "STOP";
    message?: string | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"GOTO">;
    target: z.ZodEffects<z.ZodObject<{
        step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
        substep: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        step: string | (number & z.BRAND<"StepNumber">);
        substep?: string | undefined;
    }, {
        step: string | number;
        substep?: string | undefined;
    }>, {
        step: string | (number & z.BRAND<"StepNumber">);
        substep?: string | undefined;
    }, {
        step: string | number;
        substep?: string | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    type: "GOTO";
    target: {
        step: string | (number & z.BRAND<"StepNumber">);
        substep?: string | undefined;
    };
}, {
    type: "GOTO";
    target: {
        step: string | number;
        substep?: string | undefined;
    };
}>]>, z.ZodObject<{
    type: z.ZodLiteral<"RETRY">;
    max: z.ZodNumber;
    then: z.ZodUnion<[z.ZodObject<{
        type: z.ZodLiteral<"CONTINUE">;
    }, "strip", z.ZodTypeAny, {
        type: "CONTINUE";
    }, {
        type: "CONTINUE";
    }>, z.ZodObject<{
        type: z.ZodLiteral<"COMPLETE">;
        message: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type: "COMPLETE";
        message?: string | undefined;
    }, {
        type: "COMPLETE";
        message?: string | undefined;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"STOP">;
        message: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type: "STOP";
        message?: string | undefined;
    }, {
        type: "STOP";
        message?: string | undefined;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"GOTO">;
        target: z.ZodEffects<z.ZodObject<{
            step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
            substep: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            step: string | (number & z.BRAND<"StepNumber">);
            substep?: string | undefined;
        }, {
            step: string | number;
            substep?: string | undefined;
        }>, {
            step: string | (number & z.BRAND<"StepNumber">);
            substep?: string | undefined;
        }, {
            step: string | number;
            substep?: string | undefined;
        }>;
    }, "strip", z.ZodTypeAny, {
        type: "GOTO";
        target: {
            step: string | (number & z.BRAND<"StepNumber">);
            substep?: string | undefined;
        };
    }, {
        type: "GOTO";
        target: {
            step: string | number;
            substep?: string | undefined;
        };
    }>]>;
}, "strip", z.ZodTypeAny, {
    type: "RETRY";
    max: number;
    then: {
        type: "CONTINUE";
    } | {
        type: "COMPLETE";
        message?: string | undefined;
    } | {
        type: "STOP";
        message?: string | undefined;
    } | {
        type: "GOTO";
        target: {
            step: string | (number & z.BRAND<"StepNumber">);
            substep?: string | undefined;
        };
    };
}, {
    type: "RETRY";
    max: number;
    then: {
        type: "CONTINUE";
    } | {
        type: "COMPLETE";
        message?: string | undefined;
    } | {
        type: "STOP";
        message?: string | undefined;
    } | {
        type: "GOTO";
        target: {
            step: string | number;
            substep?: string | undefined;
        };
    };
}>]>;
export type Action = Readonly<z.output<typeof ActionSchema>>;
/**
 * Valid transition kinds
 */
export declare const TransitionKindSchema: z.ZodEnum<["pass", "fail", "yes", "no"]>;
export type TransitionKind = z.output<typeof TransitionKindSchema>;
/**
 * Zod schema for TransitionObject (individual transition with kind)
 */
export declare const TransitionObjectSchema: z.ZodObject<{
    kind: z.ZodEnum<["pass", "fail", "yes", "no"]>;
    action: z.ZodUnion<[z.ZodUnion<[z.ZodObject<{
        type: z.ZodLiteral<"CONTINUE">;
    }, "strip", z.ZodTypeAny, {
        type: "CONTINUE";
    }, {
        type: "CONTINUE";
    }>, z.ZodObject<{
        type: z.ZodLiteral<"COMPLETE">;
        message: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type: "COMPLETE";
        message?: string | undefined;
    }, {
        type: "COMPLETE";
        message?: string | undefined;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"STOP">;
        message: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type: "STOP";
        message?: string | undefined;
    }, {
        type: "STOP";
        message?: string | undefined;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"GOTO">;
        target: z.ZodEffects<z.ZodObject<{
            step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
            substep: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            step: string | (number & z.BRAND<"StepNumber">);
            substep?: string | undefined;
        }, {
            step: string | number;
            substep?: string | undefined;
        }>, {
            step: string | (number & z.BRAND<"StepNumber">);
            substep?: string | undefined;
        }, {
            step: string | number;
            substep?: string | undefined;
        }>;
    }, "strip", z.ZodTypeAny, {
        type: "GOTO";
        target: {
            step: string | (number & z.BRAND<"StepNumber">);
            substep?: string | undefined;
        };
    }, {
        type: "GOTO";
        target: {
            step: string | number;
            substep?: string | undefined;
        };
    }>]>, z.ZodObject<{
        type: z.ZodLiteral<"RETRY">;
        max: z.ZodNumber;
        then: z.ZodUnion<[z.ZodObject<{
            type: z.ZodLiteral<"CONTINUE">;
        }, "strip", z.ZodTypeAny, {
            type: "CONTINUE";
        }, {
            type: "CONTINUE";
        }>, z.ZodObject<{
            type: z.ZodLiteral<"COMPLETE">;
            message: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            type: "COMPLETE";
            message?: string | undefined;
        }, {
            type: "COMPLETE";
            message?: string | undefined;
        }>, z.ZodObject<{
            type: z.ZodLiteral<"STOP">;
            message: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            type: "STOP";
            message?: string | undefined;
        }, {
            type: "STOP";
            message?: string | undefined;
        }>, z.ZodObject<{
            type: z.ZodLiteral<"GOTO">;
            target: z.ZodEffects<z.ZodObject<{
                step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                substep: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                step: string | (number & z.BRAND<"StepNumber">);
                substep?: string | undefined;
            }, {
                step: string | number;
                substep?: string | undefined;
            }>, {
                step: string | (number & z.BRAND<"StepNumber">);
                substep?: string | undefined;
            }, {
                step: string | number;
                substep?: string | undefined;
            }>;
        }, "strip", z.ZodTypeAny, {
            type: "GOTO";
            target: {
                step: string | (number & z.BRAND<"StepNumber">);
                substep?: string | undefined;
            };
        }, {
            type: "GOTO";
            target: {
                step: string | number;
                substep?: string | undefined;
            };
        }>]>;
    }, "strip", z.ZodTypeAny, {
        type: "RETRY";
        max: number;
        then: {
            type: "CONTINUE";
        } | {
            type: "COMPLETE";
            message?: string | undefined;
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: string | (number & z.BRAND<"StepNumber">);
                substep?: string | undefined;
            };
        };
    }, {
        type: "RETRY";
        max: number;
        then: {
            type: "CONTINUE";
        } | {
            type: "COMPLETE";
            message?: string | undefined;
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: string | number;
                substep?: string | undefined;
            };
        };
    }>]>;
}, "strip", z.ZodTypeAny, {
    kind: "pass" | "fail" | "yes" | "no";
    action: {
        type: "CONTINUE";
    } | {
        type: "COMPLETE";
        message?: string | undefined;
    } | {
        type: "STOP";
        message?: string | undefined;
    } | {
        type: "GOTO";
        target: {
            step: string | (number & z.BRAND<"StepNumber">);
            substep?: string | undefined;
        };
    } | {
        type: "RETRY";
        max: number;
        then: {
            type: "CONTINUE";
        } | {
            type: "COMPLETE";
            message?: string | undefined;
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: string | (number & z.BRAND<"StepNumber">);
                substep?: string | undefined;
            };
        };
    };
}, {
    kind: "pass" | "fail" | "yes" | "no";
    action: {
        type: "CONTINUE";
    } | {
        type: "COMPLETE";
        message?: string | undefined;
    } | {
        type: "STOP";
        message?: string | undefined;
    } | {
        type: "GOTO";
        target: {
            step: string | number;
            substep?: string | undefined;
        };
    } | {
        type: "RETRY";
        max: number;
        then: {
            type: "CONTINUE";
        } | {
            type: "COMPLETE";
            message?: string | undefined;
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: string | number;
                substep?: string | undefined;
            };
        };
    };
}>;
export type TransitionObject = Readonly<z.output<typeof TransitionObjectSchema>>;
/**
 * Zod schema for Transitions
 */
export declare const TransitionsSchema: z.ZodUnion<[z.ZodObject<{
    all: z.ZodLiteral<true>;
    pass: z.ZodObject<{
        kind: z.ZodEnum<["pass", "fail", "yes", "no"]>;
        action: z.ZodUnion<[z.ZodUnion<[z.ZodObject<{
            type: z.ZodLiteral<"CONTINUE">;
        }, "strip", z.ZodTypeAny, {
            type: "CONTINUE";
        }, {
            type: "CONTINUE";
        }>, z.ZodObject<{
            type: z.ZodLiteral<"COMPLETE">;
            message: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            type: "COMPLETE";
            message?: string | undefined;
        }, {
            type: "COMPLETE";
            message?: string | undefined;
        }>, z.ZodObject<{
            type: z.ZodLiteral<"STOP">;
            message: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            type: "STOP";
            message?: string | undefined;
        }, {
            type: "STOP";
            message?: string | undefined;
        }>, z.ZodObject<{
            type: z.ZodLiteral<"GOTO">;
            target: z.ZodEffects<z.ZodObject<{
                step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                substep: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                step: string | (number & z.BRAND<"StepNumber">);
                substep?: string | undefined;
            }, {
                step: string | number;
                substep?: string | undefined;
            }>, {
                step: string | (number & z.BRAND<"StepNumber">);
                substep?: string | undefined;
            }, {
                step: string | number;
                substep?: string | undefined;
            }>;
        }, "strip", z.ZodTypeAny, {
            type: "GOTO";
            target: {
                step: string | (number & z.BRAND<"StepNumber">);
                substep?: string | undefined;
            };
        }, {
            type: "GOTO";
            target: {
                step: string | number;
                substep?: string | undefined;
            };
        }>]>, z.ZodObject<{
            type: z.ZodLiteral<"RETRY">;
            max: z.ZodNumber;
            then: z.ZodUnion<[z.ZodObject<{
                type: z.ZodLiteral<"CONTINUE">;
            }, "strip", z.ZodTypeAny, {
                type: "CONTINUE";
            }, {
                type: "CONTINUE";
            }>, z.ZodObject<{
                type: z.ZodLiteral<"COMPLETE">;
                message: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                type: "COMPLETE";
                message?: string | undefined;
            }, {
                type: "COMPLETE";
                message?: string | undefined;
            }>, z.ZodObject<{
                type: z.ZodLiteral<"STOP">;
                message: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                type: "STOP";
                message?: string | undefined;
            }, {
                type: "STOP";
                message?: string | undefined;
            }>, z.ZodObject<{
                type: z.ZodLiteral<"GOTO">;
                target: z.ZodEffects<z.ZodObject<{
                    step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                    substep: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                }, {
                    step: string | number;
                    substep?: string | undefined;
                }>, {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                }, {
                    step: string | number;
                    substep?: string | undefined;
                }>;
            }, "strip", z.ZodTypeAny, {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            }, {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            }>]>;
        }, "strip", z.ZodTypeAny, {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            };
        }, {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            };
        }>]>;
    }, "strip", z.ZodTypeAny, {
        kind: "pass" | "fail" | "yes" | "no";
        action: {
            type: "CONTINUE";
        } | {
            type: "COMPLETE";
            message?: string | undefined;
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: string | (number & z.BRAND<"StepNumber">);
                substep?: string | undefined;
            };
        } | {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            };
        };
    }, {
        kind: "pass" | "fail" | "yes" | "no";
        action: {
            type: "CONTINUE";
        } | {
            type: "COMPLETE";
            message?: string | undefined;
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: string | number;
                substep?: string | undefined;
            };
        } | {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            };
        };
    }>;
    fail: z.ZodObject<{
        kind: z.ZodEnum<["pass", "fail", "yes", "no"]>;
        action: z.ZodUnion<[z.ZodUnion<[z.ZodObject<{
            type: z.ZodLiteral<"CONTINUE">;
        }, "strip", z.ZodTypeAny, {
            type: "CONTINUE";
        }, {
            type: "CONTINUE";
        }>, z.ZodObject<{
            type: z.ZodLiteral<"COMPLETE">;
            message: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            type: "COMPLETE";
            message?: string | undefined;
        }, {
            type: "COMPLETE";
            message?: string | undefined;
        }>, z.ZodObject<{
            type: z.ZodLiteral<"STOP">;
            message: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            type: "STOP";
            message?: string | undefined;
        }, {
            type: "STOP";
            message?: string | undefined;
        }>, z.ZodObject<{
            type: z.ZodLiteral<"GOTO">;
            target: z.ZodEffects<z.ZodObject<{
                step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                substep: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                step: string | (number & z.BRAND<"StepNumber">);
                substep?: string | undefined;
            }, {
                step: string | number;
                substep?: string | undefined;
            }>, {
                step: string | (number & z.BRAND<"StepNumber">);
                substep?: string | undefined;
            }, {
                step: string | number;
                substep?: string | undefined;
            }>;
        }, "strip", z.ZodTypeAny, {
            type: "GOTO";
            target: {
                step: string | (number & z.BRAND<"StepNumber">);
                substep?: string | undefined;
            };
        }, {
            type: "GOTO";
            target: {
                step: string | number;
                substep?: string | undefined;
            };
        }>]>, z.ZodObject<{
            type: z.ZodLiteral<"RETRY">;
            max: z.ZodNumber;
            then: z.ZodUnion<[z.ZodObject<{
                type: z.ZodLiteral<"CONTINUE">;
            }, "strip", z.ZodTypeAny, {
                type: "CONTINUE";
            }, {
                type: "CONTINUE";
            }>, z.ZodObject<{
                type: z.ZodLiteral<"COMPLETE">;
                message: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                type: "COMPLETE";
                message?: string | undefined;
            }, {
                type: "COMPLETE";
                message?: string | undefined;
            }>, z.ZodObject<{
                type: z.ZodLiteral<"STOP">;
                message: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                type: "STOP";
                message?: string | undefined;
            }, {
                type: "STOP";
                message?: string | undefined;
            }>, z.ZodObject<{
                type: z.ZodLiteral<"GOTO">;
                target: z.ZodEffects<z.ZodObject<{
                    step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                    substep: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                }, {
                    step: string | number;
                    substep?: string | undefined;
                }>, {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                }, {
                    step: string | number;
                    substep?: string | undefined;
                }>;
            }, "strip", z.ZodTypeAny, {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            }, {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            }>]>;
        }, "strip", z.ZodTypeAny, {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            };
        }, {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            };
        }>]>;
    }, "strip", z.ZodTypeAny, {
        kind: "pass" | "fail" | "yes" | "no";
        action: {
            type: "CONTINUE";
        } | {
            type: "COMPLETE";
            message?: string | undefined;
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: string | (number & z.BRAND<"StepNumber">);
                substep?: string | undefined;
            };
        } | {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            };
        };
    }, {
        kind: "pass" | "fail" | "yes" | "no";
        action: {
            type: "CONTINUE";
        } | {
            type: "COMPLETE";
            message?: string | undefined;
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: string | number;
                substep?: string | undefined;
            };
        } | {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            };
        };
    }>;
}, "strip", z.ZodTypeAny, {
    pass: {
        kind: "pass" | "fail" | "yes" | "no";
        action: {
            type: "CONTINUE";
        } | {
            type: "COMPLETE";
            message?: string | undefined;
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: string | (number & z.BRAND<"StepNumber">);
                substep?: string | undefined;
            };
        } | {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            };
        };
    };
    fail: {
        kind: "pass" | "fail" | "yes" | "no";
        action: {
            type: "CONTINUE";
        } | {
            type: "COMPLETE";
            message?: string | undefined;
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: string | (number & z.BRAND<"StepNumber">);
                substep?: string | undefined;
            };
        } | {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            };
        };
    };
    all: true;
}, {
    pass: {
        kind: "pass" | "fail" | "yes" | "no";
        action: {
            type: "CONTINUE";
        } | {
            type: "COMPLETE";
            message?: string | undefined;
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: string | number;
                substep?: string | undefined;
            };
        } | {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            };
        };
    };
    fail: {
        kind: "pass" | "fail" | "yes" | "no";
        action: {
            type: "CONTINUE";
        } | {
            type: "COMPLETE";
            message?: string | undefined;
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: string | number;
                substep?: string | undefined;
            };
        } | {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            };
        };
    };
    all: true;
}>, z.ZodObject<{
    all: z.ZodLiteral<false>;
    pass: z.ZodObject<{
        kind: z.ZodEnum<["pass", "fail", "yes", "no"]>;
        action: z.ZodUnion<[z.ZodUnion<[z.ZodObject<{
            type: z.ZodLiteral<"CONTINUE">;
        }, "strip", z.ZodTypeAny, {
            type: "CONTINUE";
        }, {
            type: "CONTINUE";
        }>, z.ZodObject<{
            type: z.ZodLiteral<"COMPLETE">;
            message: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            type: "COMPLETE";
            message?: string | undefined;
        }, {
            type: "COMPLETE";
            message?: string | undefined;
        }>, z.ZodObject<{
            type: z.ZodLiteral<"STOP">;
            message: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            type: "STOP";
            message?: string | undefined;
        }, {
            type: "STOP";
            message?: string | undefined;
        }>, z.ZodObject<{
            type: z.ZodLiteral<"GOTO">;
            target: z.ZodEffects<z.ZodObject<{
                step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                substep: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                step: string | (number & z.BRAND<"StepNumber">);
                substep?: string | undefined;
            }, {
                step: string | number;
                substep?: string | undefined;
            }>, {
                step: string | (number & z.BRAND<"StepNumber">);
                substep?: string | undefined;
            }, {
                step: string | number;
                substep?: string | undefined;
            }>;
        }, "strip", z.ZodTypeAny, {
            type: "GOTO";
            target: {
                step: string | (number & z.BRAND<"StepNumber">);
                substep?: string | undefined;
            };
        }, {
            type: "GOTO";
            target: {
                step: string | number;
                substep?: string | undefined;
            };
        }>]>, z.ZodObject<{
            type: z.ZodLiteral<"RETRY">;
            max: z.ZodNumber;
            then: z.ZodUnion<[z.ZodObject<{
                type: z.ZodLiteral<"CONTINUE">;
            }, "strip", z.ZodTypeAny, {
                type: "CONTINUE";
            }, {
                type: "CONTINUE";
            }>, z.ZodObject<{
                type: z.ZodLiteral<"COMPLETE">;
                message: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                type: "COMPLETE";
                message?: string | undefined;
            }, {
                type: "COMPLETE";
                message?: string | undefined;
            }>, z.ZodObject<{
                type: z.ZodLiteral<"STOP">;
                message: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                type: "STOP";
                message?: string | undefined;
            }, {
                type: "STOP";
                message?: string | undefined;
            }>, z.ZodObject<{
                type: z.ZodLiteral<"GOTO">;
                target: z.ZodEffects<z.ZodObject<{
                    step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                    substep: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                }, {
                    step: string | number;
                    substep?: string | undefined;
                }>, {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                }, {
                    step: string | number;
                    substep?: string | undefined;
                }>;
            }, "strip", z.ZodTypeAny, {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            }, {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            }>]>;
        }, "strip", z.ZodTypeAny, {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            };
        }, {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            };
        }>]>;
    }, "strip", z.ZodTypeAny, {
        kind: "pass" | "fail" | "yes" | "no";
        action: {
            type: "CONTINUE";
        } | {
            type: "COMPLETE";
            message?: string | undefined;
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: string | (number & z.BRAND<"StepNumber">);
                substep?: string | undefined;
            };
        } | {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            };
        };
    }, {
        kind: "pass" | "fail" | "yes" | "no";
        action: {
            type: "CONTINUE";
        } | {
            type: "COMPLETE";
            message?: string | undefined;
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: string | number;
                substep?: string | undefined;
            };
        } | {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            };
        };
    }>;
    fail: z.ZodObject<{
        kind: z.ZodEnum<["pass", "fail", "yes", "no"]>;
        action: z.ZodUnion<[z.ZodUnion<[z.ZodObject<{
            type: z.ZodLiteral<"CONTINUE">;
        }, "strip", z.ZodTypeAny, {
            type: "CONTINUE";
        }, {
            type: "CONTINUE";
        }>, z.ZodObject<{
            type: z.ZodLiteral<"COMPLETE">;
            message: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            type: "COMPLETE";
            message?: string | undefined;
        }, {
            type: "COMPLETE";
            message?: string | undefined;
        }>, z.ZodObject<{
            type: z.ZodLiteral<"STOP">;
            message: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            type: "STOP";
            message?: string | undefined;
        }, {
            type: "STOP";
            message?: string | undefined;
        }>, z.ZodObject<{
            type: z.ZodLiteral<"GOTO">;
            target: z.ZodEffects<z.ZodObject<{
                step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                substep: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                step: string | (number & z.BRAND<"StepNumber">);
                substep?: string | undefined;
            }, {
                step: string | number;
                substep?: string | undefined;
            }>, {
                step: string | (number & z.BRAND<"StepNumber">);
                substep?: string | undefined;
            }, {
                step: string | number;
                substep?: string | undefined;
            }>;
        }, "strip", z.ZodTypeAny, {
            type: "GOTO";
            target: {
                step: string | (number & z.BRAND<"StepNumber">);
                substep?: string | undefined;
            };
        }, {
            type: "GOTO";
            target: {
                step: string | number;
                substep?: string | undefined;
            };
        }>]>, z.ZodObject<{
            type: z.ZodLiteral<"RETRY">;
            max: z.ZodNumber;
            then: z.ZodUnion<[z.ZodObject<{
                type: z.ZodLiteral<"CONTINUE">;
            }, "strip", z.ZodTypeAny, {
                type: "CONTINUE";
            }, {
                type: "CONTINUE";
            }>, z.ZodObject<{
                type: z.ZodLiteral<"COMPLETE">;
                message: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                type: "COMPLETE";
                message?: string | undefined;
            }, {
                type: "COMPLETE";
                message?: string | undefined;
            }>, z.ZodObject<{
                type: z.ZodLiteral<"STOP">;
                message: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                type: "STOP";
                message?: string | undefined;
            }, {
                type: "STOP";
                message?: string | undefined;
            }>, z.ZodObject<{
                type: z.ZodLiteral<"GOTO">;
                target: z.ZodEffects<z.ZodObject<{
                    step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                    substep: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                }, {
                    step: string | number;
                    substep?: string | undefined;
                }>, {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                }, {
                    step: string | number;
                    substep?: string | undefined;
                }>;
            }, "strip", z.ZodTypeAny, {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            }, {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            }>]>;
        }, "strip", z.ZodTypeAny, {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            };
        }, {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            };
        }>]>;
    }, "strip", z.ZodTypeAny, {
        kind: "pass" | "fail" | "yes" | "no";
        action: {
            type: "CONTINUE";
        } | {
            type: "COMPLETE";
            message?: string | undefined;
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: string | (number & z.BRAND<"StepNumber">);
                substep?: string | undefined;
            };
        } | {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            };
        };
    }, {
        kind: "pass" | "fail" | "yes" | "no";
        action: {
            type: "CONTINUE";
        } | {
            type: "COMPLETE";
            message?: string | undefined;
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: string | number;
                substep?: string | undefined;
            };
        } | {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            };
        };
    }>;
}, "strip", z.ZodTypeAny, {
    pass: {
        kind: "pass" | "fail" | "yes" | "no";
        action: {
            type: "CONTINUE";
        } | {
            type: "COMPLETE";
            message?: string | undefined;
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: string | (number & z.BRAND<"StepNumber">);
                substep?: string | undefined;
            };
        } | {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            };
        };
    };
    fail: {
        kind: "pass" | "fail" | "yes" | "no";
        action: {
            type: "CONTINUE";
        } | {
            type: "COMPLETE";
            message?: string | undefined;
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: string | (number & z.BRAND<"StepNumber">);
                substep?: string | undefined;
            };
        } | {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            };
        };
    };
    all: false;
}, {
    pass: {
        kind: "pass" | "fail" | "yes" | "no";
        action: {
            type: "CONTINUE";
        } | {
            type: "COMPLETE";
            message?: string | undefined;
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: string | number;
                substep?: string | undefined;
            };
        } | {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            };
        };
    };
    fail: {
        kind: "pass" | "fail" | "yes" | "no";
        action: {
            type: "CONTINUE";
        } | {
            type: "COMPLETE";
            message?: string | undefined;
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: string | number;
                substep?: string | undefined;
            };
        } | {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            };
        };
    };
    all: false;
}>]>;
export type Transitions = Readonly<z.output<typeof TransitionsSchema>>;
/**
 * Zod schema for Substep
 */
export declare const SubstepSchema: z.ZodObject<{
    id: z.ZodString;
    description: z.ZodString;
    agentType: z.ZodOptional<z.ZodString>;
    isDynamic: z.ZodBoolean;
    isNamed: z.ZodBoolean;
    workflows: z.ZodOptional<z.ZodReadonly<z.ZodArray<z.ZodString, "many">>>;
    command: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        code: string;
    }, {
        code: string;
    }>>;
    prompt: z.ZodOptional<z.ZodString>;
    transitions: z.ZodOptional<z.ZodUnion<[z.ZodObject<{
        all: z.ZodLiteral<true>;
        pass: z.ZodObject<{
            kind: z.ZodEnum<["pass", "fail", "yes", "no"]>;
            action: z.ZodUnion<[z.ZodUnion<[z.ZodObject<{
                type: z.ZodLiteral<"CONTINUE">;
            }, "strip", z.ZodTypeAny, {
                type: "CONTINUE";
            }, {
                type: "CONTINUE";
            }>, z.ZodObject<{
                type: z.ZodLiteral<"COMPLETE">;
                message: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                type: "COMPLETE";
                message?: string | undefined;
            }, {
                type: "COMPLETE";
                message?: string | undefined;
            }>, z.ZodObject<{
                type: z.ZodLiteral<"STOP">;
                message: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                type: "STOP";
                message?: string | undefined;
            }, {
                type: "STOP";
                message?: string | undefined;
            }>, z.ZodObject<{
                type: z.ZodLiteral<"GOTO">;
                target: z.ZodEffects<z.ZodObject<{
                    step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                    substep: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                }, {
                    step: string | number;
                    substep?: string | undefined;
                }>, {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                }, {
                    step: string | number;
                    substep?: string | undefined;
                }>;
            }, "strip", z.ZodTypeAny, {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            }, {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            }>]>, z.ZodObject<{
                type: z.ZodLiteral<"RETRY">;
                max: z.ZodNumber;
                then: z.ZodUnion<[z.ZodObject<{
                    type: z.ZodLiteral<"CONTINUE">;
                }, "strip", z.ZodTypeAny, {
                    type: "CONTINUE";
                }, {
                    type: "CONTINUE";
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"COMPLETE">;
                    message: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    type: "COMPLETE";
                    message?: string | undefined;
                }, {
                    type: "COMPLETE";
                    message?: string | undefined;
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"STOP">;
                    message: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    type: "STOP";
                    message?: string | undefined;
                }, {
                    type: "STOP";
                    message?: string | undefined;
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"GOTO">;
                    target: z.ZodEffects<z.ZodObject<{
                        step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                        substep: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    }, {
                        step: string | number;
                        substep?: string | undefined;
                    }>, {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    }, {
                        step: string | number;
                        substep?: string | undefined;
                    }>;
                }, "strip", z.ZodTypeAny, {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                }, {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                }>]>;
            }, "strip", z.ZodTypeAny, {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                };
            }, {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                };
            }>]>;
        }, "strip", z.ZodTypeAny, {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                };
            };
        }, {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                };
            };
        }>;
        fail: z.ZodObject<{
            kind: z.ZodEnum<["pass", "fail", "yes", "no"]>;
            action: z.ZodUnion<[z.ZodUnion<[z.ZodObject<{
                type: z.ZodLiteral<"CONTINUE">;
            }, "strip", z.ZodTypeAny, {
                type: "CONTINUE";
            }, {
                type: "CONTINUE";
            }>, z.ZodObject<{
                type: z.ZodLiteral<"COMPLETE">;
                message: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                type: "COMPLETE";
                message?: string | undefined;
            }, {
                type: "COMPLETE";
                message?: string | undefined;
            }>, z.ZodObject<{
                type: z.ZodLiteral<"STOP">;
                message: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                type: "STOP";
                message?: string | undefined;
            }, {
                type: "STOP";
                message?: string | undefined;
            }>, z.ZodObject<{
                type: z.ZodLiteral<"GOTO">;
                target: z.ZodEffects<z.ZodObject<{
                    step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                    substep: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                }, {
                    step: string | number;
                    substep?: string | undefined;
                }>, {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                }, {
                    step: string | number;
                    substep?: string | undefined;
                }>;
            }, "strip", z.ZodTypeAny, {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            }, {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            }>]>, z.ZodObject<{
                type: z.ZodLiteral<"RETRY">;
                max: z.ZodNumber;
                then: z.ZodUnion<[z.ZodObject<{
                    type: z.ZodLiteral<"CONTINUE">;
                }, "strip", z.ZodTypeAny, {
                    type: "CONTINUE";
                }, {
                    type: "CONTINUE";
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"COMPLETE">;
                    message: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    type: "COMPLETE";
                    message?: string | undefined;
                }, {
                    type: "COMPLETE";
                    message?: string | undefined;
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"STOP">;
                    message: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    type: "STOP";
                    message?: string | undefined;
                }, {
                    type: "STOP";
                    message?: string | undefined;
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"GOTO">;
                    target: z.ZodEffects<z.ZodObject<{
                        step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                        substep: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    }, {
                        step: string | number;
                        substep?: string | undefined;
                    }>, {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    }, {
                        step: string | number;
                        substep?: string | undefined;
                    }>;
                }, "strip", z.ZodTypeAny, {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                }, {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                }>]>;
            }, "strip", z.ZodTypeAny, {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                };
            }, {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                };
            }>]>;
        }, "strip", z.ZodTypeAny, {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                };
            };
        }, {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                };
            };
        }>;
    }, "strip", z.ZodTypeAny, {
        pass: {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                };
            };
        };
        fail: {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                };
            };
        };
        all: true;
    }, {
        pass: {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                };
            };
        };
        fail: {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                };
            };
        };
        all: true;
    }>, z.ZodObject<{
        all: z.ZodLiteral<false>;
        pass: z.ZodObject<{
            kind: z.ZodEnum<["pass", "fail", "yes", "no"]>;
            action: z.ZodUnion<[z.ZodUnion<[z.ZodObject<{
                type: z.ZodLiteral<"CONTINUE">;
            }, "strip", z.ZodTypeAny, {
                type: "CONTINUE";
            }, {
                type: "CONTINUE";
            }>, z.ZodObject<{
                type: z.ZodLiteral<"COMPLETE">;
                message: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                type: "COMPLETE";
                message?: string | undefined;
            }, {
                type: "COMPLETE";
                message?: string | undefined;
            }>, z.ZodObject<{
                type: z.ZodLiteral<"STOP">;
                message: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                type: "STOP";
                message?: string | undefined;
            }, {
                type: "STOP";
                message?: string | undefined;
            }>, z.ZodObject<{
                type: z.ZodLiteral<"GOTO">;
                target: z.ZodEffects<z.ZodObject<{
                    step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                    substep: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                }, {
                    step: string | number;
                    substep?: string | undefined;
                }>, {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                }, {
                    step: string | number;
                    substep?: string | undefined;
                }>;
            }, "strip", z.ZodTypeAny, {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            }, {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            }>]>, z.ZodObject<{
                type: z.ZodLiteral<"RETRY">;
                max: z.ZodNumber;
                then: z.ZodUnion<[z.ZodObject<{
                    type: z.ZodLiteral<"CONTINUE">;
                }, "strip", z.ZodTypeAny, {
                    type: "CONTINUE";
                }, {
                    type: "CONTINUE";
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"COMPLETE">;
                    message: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    type: "COMPLETE";
                    message?: string | undefined;
                }, {
                    type: "COMPLETE";
                    message?: string | undefined;
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"STOP">;
                    message: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    type: "STOP";
                    message?: string | undefined;
                }, {
                    type: "STOP";
                    message?: string | undefined;
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"GOTO">;
                    target: z.ZodEffects<z.ZodObject<{
                        step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                        substep: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    }, {
                        step: string | number;
                        substep?: string | undefined;
                    }>, {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    }, {
                        step: string | number;
                        substep?: string | undefined;
                    }>;
                }, "strip", z.ZodTypeAny, {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                }, {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                }>]>;
            }, "strip", z.ZodTypeAny, {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                };
            }, {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                };
            }>]>;
        }, "strip", z.ZodTypeAny, {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                };
            };
        }, {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                };
            };
        }>;
        fail: z.ZodObject<{
            kind: z.ZodEnum<["pass", "fail", "yes", "no"]>;
            action: z.ZodUnion<[z.ZodUnion<[z.ZodObject<{
                type: z.ZodLiteral<"CONTINUE">;
            }, "strip", z.ZodTypeAny, {
                type: "CONTINUE";
            }, {
                type: "CONTINUE";
            }>, z.ZodObject<{
                type: z.ZodLiteral<"COMPLETE">;
                message: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                type: "COMPLETE";
                message?: string | undefined;
            }, {
                type: "COMPLETE";
                message?: string | undefined;
            }>, z.ZodObject<{
                type: z.ZodLiteral<"STOP">;
                message: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                type: "STOP";
                message?: string | undefined;
            }, {
                type: "STOP";
                message?: string | undefined;
            }>, z.ZodObject<{
                type: z.ZodLiteral<"GOTO">;
                target: z.ZodEffects<z.ZodObject<{
                    step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                    substep: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                }, {
                    step: string | number;
                    substep?: string | undefined;
                }>, {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                }, {
                    step: string | number;
                    substep?: string | undefined;
                }>;
            }, "strip", z.ZodTypeAny, {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            }, {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            }>]>, z.ZodObject<{
                type: z.ZodLiteral<"RETRY">;
                max: z.ZodNumber;
                then: z.ZodUnion<[z.ZodObject<{
                    type: z.ZodLiteral<"CONTINUE">;
                }, "strip", z.ZodTypeAny, {
                    type: "CONTINUE";
                }, {
                    type: "CONTINUE";
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"COMPLETE">;
                    message: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    type: "COMPLETE";
                    message?: string | undefined;
                }, {
                    type: "COMPLETE";
                    message?: string | undefined;
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"STOP">;
                    message: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    type: "STOP";
                    message?: string | undefined;
                }, {
                    type: "STOP";
                    message?: string | undefined;
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"GOTO">;
                    target: z.ZodEffects<z.ZodObject<{
                        step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                        substep: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    }, {
                        step: string | number;
                        substep?: string | undefined;
                    }>, {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    }, {
                        step: string | number;
                        substep?: string | undefined;
                    }>;
                }, "strip", z.ZodTypeAny, {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                }, {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                }>]>;
            }, "strip", z.ZodTypeAny, {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                };
            }, {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                };
            }>]>;
        }, "strip", z.ZodTypeAny, {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                };
            };
        }, {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                };
            };
        }>;
    }, "strip", z.ZodTypeAny, {
        pass: {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                };
            };
        };
        fail: {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                };
            };
        };
        all: false;
    }, {
        pass: {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                };
            };
        };
        fail: {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                };
            };
        };
        all: false;
    }>]>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    description: string;
    isDynamic: boolean;
    isNamed: boolean;
    agentType?: string | undefined;
    workflows?: readonly string[] | undefined;
    command?: {
        code: string;
    } | undefined;
    prompt?: string | undefined;
    transitions?: {
        pass: {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                };
            };
        };
        fail: {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                };
            };
        };
        all: true;
    } | {
        pass: {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                };
            };
        };
        fail: {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                };
            };
        };
        all: false;
    } | undefined;
}, {
    id: string;
    description: string;
    isDynamic: boolean;
    isNamed: boolean;
    agentType?: string | undefined;
    workflows?: readonly string[] | undefined;
    command?: {
        code: string;
    } | undefined;
    prompt?: string | undefined;
    transitions?: {
        pass: {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                };
            };
        };
        fail: {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                };
            };
        };
        all: true;
    } | {
        pass: {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                };
            };
        };
        fail: {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                };
            };
        };
        all: false;
    } | undefined;
}>;
/**
 * Zod schema for Step
 */
export declare const StepSchema: z.ZodObject<{
    number: z.ZodOptional<z.ZodBranded<z.ZodNumber, "StepNumber">>;
    name: z.ZodOptional<z.ZodString>;
    isDynamic: z.ZodBoolean;
    isNamed: z.ZodBoolean;
    description: z.ZodString;
    command: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        code: string;
    }, {
        code: string;
    }>>;
    prompt: z.ZodOptional<z.ZodString>;
    transitions: z.ZodOptional<z.ZodUnion<[z.ZodObject<{
        all: z.ZodLiteral<true>;
        pass: z.ZodObject<{
            kind: z.ZodEnum<["pass", "fail", "yes", "no"]>;
            action: z.ZodUnion<[z.ZodUnion<[z.ZodObject<{
                type: z.ZodLiteral<"CONTINUE">;
            }, "strip", z.ZodTypeAny, {
                type: "CONTINUE";
            }, {
                type: "CONTINUE";
            }>, z.ZodObject<{
                type: z.ZodLiteral<"COMPLETE">;
                message: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                type: "COMPLETE";
                message?: string | undefined;
            }, {
                type: "COMPLETE";
                message?: string | undefined;
            }>, z.ZodObject<{
                type: z.ZodLiteral<"STOP">;
                message: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                type: "STOP";
                message?: string | undefined;
            }, {
                type: "STOP";
                message?: string | undefined;
            }>, z.ZodObject<{
                type: z.ZodLiteral<"GOTO">;
                target: z.ZodEffects<z.ZodObject<{
                    step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                    substep: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                }, {
                    step: string | number;
                    substep?: string | undefined;
                }>, {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                }, {
                    step: string | number;
                    substep?: string | undefined;
                }>;
            }, "strip", z.ZodTypeAny, {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            }, {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            }>]>, z.ZodObject<{
                type: z.ZodLiteral<"RETRY">;
                max: z.ZodNumber;
                then: z.ZodUnion<[z.ZodObject<{
                    type: z.ZodLiteral<"CONTINUE">;
                }, "strip", z.ZodTypeAny, {
                    type: "CONTINUE";
                }, {
                    type: "CONTINUE";
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"COMPLETE">;
                    message: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    type: "COMPLETE";
                    message?: string | undefined;
                }, {
                    type: "COMPLETE";
                    message?: string | undefined;
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"STOP">;
                    message: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    type: "STOP";
                    message?: string | undefined;
                }, {
                    type: "STOP";
                    message?: string | undefined;
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"GOTO">;
                    target: z.ZodEffects<z.ZodObject<{
                        step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                        substep: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    }, {
                        step: string | number;
                        substep?: string | undefined;
                    }>, {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    }, {
                        step: string | number;
                        substep?: string | undefined;
                    }>;
                }, "strip", z.ZodTypeAny, {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                }, {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                }>]>;
            }, "strip", z.ZodTypeAny, {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                };
            }, {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                };
            }>]>;
        }, "strip", z.ZodTypeAny, {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                };
            };
        }, {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                };
            };
        }>;
        fail: z.ZodObject<{
            kind: z.ZodEnum<["pass", "fail", "yes", "no"]>;
            action: z.ZodUnion<[z.ZodUnion<[z.ZodObject<{
                type: z.ZodLiteral<"CONTINUE">;
            }, "strip", z.ZodTypeAny, {
                type: "CONTINUE";
            }, {
                type: "CONTINUE";
            }>, z.ZodObject<{
                type: z.ZodLiteral<"COMPLETE">;
                message: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                type: "COMPLETE";
                message?: string | undefined;
            }, {
                type: "COMPLETE";
                message?: string | undefined;
            }>, z.ZodObject<{
                type: z.ZodLiteral<"STOP">;
                message: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                type: "STOP";
                message?: string | undefined;
            }, {
                type: "STOP";
                message?: string | undefined;
            }>, z.ZodObject<{
                type: z.ZodLiteral<"GOTO">;
                target: z.ZodEffects<z.ZodObject<{
                    step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                    substep: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                }, {
                    step: string | number;
                    substep?: string | undefined;
                }>, {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                }, {
                    step: string | number;
                    substep?: string | undefined;
                }>;
            }, "strip", z.ZodTypeAny, {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            }, {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            }>]>, z.ZodObject<{
                type: z.ZodLiteral<"RETRY">;
                max: z.ZodNumber;
                then: z.ZodUnion<[z.ZodObject<{
                    type: z.ZodLiteral<"CONTINUE">;
                }, "strip", z.ZodTypeAny, {
                    type: "CONTINUE";
                }, {
                    type: "CONTINUE";
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"COMPLETE">;
                    message: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    type: "COMPLETE";
                    message?: string | undefined;
                }, {
                    type: "COMPLETE";
                    message?: string | undefined;
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"STOP">;
                    message: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    type: "STOP";
                    message?: string | undefined;
                }, {
                    type: "STOP";
                    message?: string | undefined;
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"GOTO">;
                    target: z.ZodEffects<z.ZodObject<{
                        step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                        substep: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    }, {
                        step: string | number;
                        substep?: string | undefined;
                    }>, {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    }, {
                        step: string | number;
                        substep?: string | undefined;
                    }>;
                }, "strip", z.ZodTypeAny, {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                }, {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                }>]>;
            }, "strip", z.ZodTypeAny, {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                };
            }, {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                };
            }>]>;
        }, "strip", z.ZodTypeAny, {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                };
            };
        }, {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                };
            };
        }>;
    }, "strip", z.ZodTypeAny, {
        pass: {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                };
            };
        };
        fail: {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                };
            };
        };
        all: true;
    }, {
        pass: {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                };
            };
        };
        fail: {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                };
            };
        };
        all: true;
    }>, z.ZodObject<{
        all: z.ZodLiteral<false>;
        pass: z.ZodObject<{
            kind: z.ZodEnum<["pass", "fail", "yes", "no"]>;
            action: z.ZodUnion<[z.ZodUnion<[z.ZodObject<{
                type: z.ZodLiteral<"CONTINUE">;
            }, "strip", z.ZodTypeAny, {
                type: "CONTINUE";
            }, {
                type: "CONTINUE";
            }>, z.ZodObject<{
                type: z.ZodLiteral<"COMPLETE">;
                message: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                type: "COMPLETE";
                message?: string | undefined;
            }, {
                type: "COMPLETE";
                message?: string | undefined;
            }>, z.ZodObject<{
                type: z.ZodLiteral<"STOP">;
                message: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                type: "STOP";
                message?: string | undefined;
            }, {
                type: "STOP";
                message?: string | undefined;
            }>, z.ZodObject<{
                type: z.ZodLiteral<"GOTO">;
                target: z.ZodEffects<z.ZodObject<{
                    step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                    substep: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                }, {
                    step: string | number;
                    substep?: string | undefined;
                }>, {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                }, {
                    step: string | number;
                    substep?: string | undefined;
                }>;
            }, "strip", z.ZodTypeAny, {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            }, {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            }>]>, z.ZodObject<{
                type: z.ZodLiteral<"RETRY">;
                max: z.ZodNumber;
                then: z.ZodUnion<[z.ZodObject<{
                    type: z.ZodLiteral<"CONTINUE">;
                }, "strip", z.ZodTypeAny, {
                    type: "CONTINUE";
                }, {
                    type: "CONTINUE";
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"COMPLETE">;
                    message: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    type: "COMPLETE";
                    message?: string | undefined;
                }, {
                    type: "COMPLETE";
                    message?: string | undefined;
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"STOP">;
                    message: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    type: "STOP";
                    message?: string | undefined;
                }, {
                    type: "STOP";
                    message?: string | undefined;
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"GOTO">;
                    target: z.ZodEffects<z.ZodObject<{
                        step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                        substep: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    }, {
                        step: string | number;
                        substep?: string | undefined;
                    }>, {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    }, {
                        step: string | number;
                        substep?: string | undefined;
                    }>;
                }, "strip", z.ZodTypeAny, {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                }, {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                }>]>;
            }, "strip", z.ZodTypeAny, {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                };
            }, {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                };
            }>]>;
        }, "strip", z.ZodTypeAny, {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                };
            };
        }, {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                };
            };
        }>;
        fail: z.ZodObject<{
            kind: z.ZodEnum<["pass", "fail", "yes", "no"]>;
            action: z.ZodUnion<[z.ZodUnion<[z.ZodObject<{
                type: z.ZodLiteral<"CONTINUE">;
            }, "strip", z.ZodTypeAny, {
                type: "CONTINUE";
            }, {
                type: "CONTINUE";
            }>, z.ZodObject<{
                type: z.ZodLiteral<"COMPLETE">;
                message: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                type: "COMPLETE";
                message?: string | undefined;
            }, {
                type: "COMPLETE";
                message?: string | undefined;
            }>, z.ZodObject<{
                type: z.ZodLiteral<"STOP">;
                message: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                type: "STOP";
                message?: string | undefined;
            }, {
                type: "STOP";
                message?: string | undefined;
            }>, z.ZodObject<{
                type: z.ZodLiteral<"GOTO">;
                target: z.ZodEffects<z.ZodObject<{
                    step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                    substep: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                }, {
                    step: string | number;
                    substep?: string | undefined;
                }>, {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                }, {
                    step: string | number;
                    substep?: string | undefined;
                }>;
            }, "strip", z.ZodTypeAny, {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            }, {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            }>]>, z.ZodObject<{
                type: z.ZodLiteral<"RETRY">;
                max: z.ZodNumber;
                then: z.ZodUnion<[z.ZodObject<{
                    type: z.ZodLiteral<"CONTINUE">;
                }, "strip", z.ZodTypeAny, {
                    type: "CONTINUE";
                }, {
                    type: "CONTINUE";
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"COMPLETE">;
                    message: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    type: "COMPLETE";
                    message?: string | undefined;
                }, {
                    type: "COMPLETE";
                    message?: string | undefined;
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"STOP">;
                    message: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    type: "STOP";
                    message?: string | undefined;
                }, {
                    type: "STOP";
                    message?: string | undefined;
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"GOTO">;
                    target: z.ZodEffects<z.ZodObject<{
                        step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                        substep: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    }, {
                        step: string | number;
                        substep?: string | undefined;
                    }>, {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    }, {
                        step: string | number;
                        substep?: string | undefined;
                    }>;
                }, "strip", z.ZodTypeAny, {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                }, {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                }>]>;
            }, "strip", z.ZodTypeAny, {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                };
            }, {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                };
            }>]>;
        }, "strip", z.ZodTypeAny, {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                };
            };
        }, {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                };
            };
        }>;
    }, "strip", z.ZodTypeAny, {
        pass: {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                };
            };
        };
        fail: {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                };
            };
        };
        all: false;
    }, {
        pass: {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                };
            };
        };
        fail: {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                };
            };
        };
        all: false;
    }>]>>;
    substeps: z.ZodOptional<z.ZodReadonly<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        description: z.ZodString;
        agentType: z.ZodOptional<z.ZodString>;
        isDynamic: z.ZodBoolean;
        isNamed: z.ZodBoolean;
        workflows: z.ZodOptional<z.ZodReadonly<z.ZodArray<z.ZodString, "many">>>;
        command: z.ZodOptional<z.ZodObject<{
            code: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            code: string;
        }, {
            code: string;
        }>>;
        prompt: z.ZodOptional<z.ZodString>;
        transitions: z.ZodOptional<z.ZodUnion<[z.ZodObject<{
            all: z.ZodLiteral<true>;
            pass: z.ZodObject<{
                kind: z.ZodEnum<["pass", "fail", "yes", "no"]>;
                action: z.ZodUnion<[z.ZodUnion<[z.ZodObject<{
                    type: z.ZodLiteral<"CONTINUE">;
                }, "strip", z.ZodTypeAny, {
                    type: "CONTINUE";
                }, {
                    type: "CONTINUE";
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"COMPLETE">;
                    message: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    type: "COMPLETE";
                    message?: string | undefined;
                }, {
                    type: "COMPLETE";
                    message?: string | undefined;
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"STOP">;
                    message: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    type: "STOP";
                    message?: string | undefined;
                }, {
                    type: "STOP";
                    message?: string | undefined;
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"GOTO">;
                    target: z.ZodEffects<z.ZodObject<{
                        step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                        substep: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    }, {
                        step: string | number;
                        substep?: string | undefined;
                    }>, {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    }, {
                        step: string | number;
                        substep?: string | undefined;
                    }>;
                }, "strip", z.ZodTypeAny, {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                }, {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                }>]>, z.ZodObject<{
                    type: z.ZodLiteral<"RETRY">;
                    max: z.ZodNumber;
                    then: z.ZodUnion<[z.ZodObject<{
                        type: z.ZodLiteral<"CONTINUE">;
                    }, "strip", z.ZodTypeAny, {
                        type: "CONTINUE";
                    }, {
                        type: "CONTINUE";
                    }>, z.ZodObject<{
                        type: z.ZodLiteral<"COMPLETE">;
                        message: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        type: "COMPLETE";
                        message?: string | undefined;
                    }, {
                        type: "COMPLETE";
                        message?: string | undefined;
                    }>, z.ZodObject<{
                        type: z.ZodLiteral<"STOP">;
                        message: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        type: "STOP";
                        message?: string | undefined;
                    }, {
                        type: "STOP";
                        message?: string | undefined;
                    }>, z.ZodObject<{
                        type: z.ZodLiteral<"GOTO">;
                        target: z.ZodEffects<z.ZodObject<{
                            step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                            substep: z.ZodOptional<z.ZodString>;
                        }, "strip", z.ZodTypeAny, {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        }, {
                            step: string | number;
                            substep?: string | undefined;
                        }>, {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        }, {
                            step: string | number;
                            substep?: string | undefined;
                        }>;
                    }, "strip", z.ZodTypeAny, {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    }, {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    }>]>;
                }, "strip", z.ZodTypeAny, {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                }, {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                }>]>;
            }, "strip", z.ZodTypeAny, {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                };
            }, {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                };
            }>;
            fail: z.ZodObject<{
                kind: z.ZodEnum<["pass", "fail", "yes", "no"]>;
                action: z.ZodUnion<[z.ZodUnion<[z.ZodObject<{
                    type: z.ZodLiteral<"CONTINUE">;
                }, "strip", z.ZodTypeAny, {
                    type: "CONTINUE";
                }, {
                    type: "CONTINUE";
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"COMPLETE">;
                    message: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    type: "COMPLETE";
                    message?: string | undefined;
                }, {
                    type: "COMPLETE";
                    message?: string | undefined;
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"STOP">;
                    message: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    type: "STOP";
                    message?: string | undefined;
                }, {
                    type: "STOP";
                    message?: string | undefined;
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"GOTO">;
                    target: z.ZodEffects<z.ZodObject<{
                        step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                        substep: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    }, {
                        step: string | number;
                        substep?: string | undefined;
                    }>, {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    }, {
                        step: string | number;
                        substep?: string | undefined;
                    }>;
                }, "strip", z.ZodTypeAny, {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                }, {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                }>]>, z.ZodObject<{
                    type: z.ZodLiteral<"RETRY">;
                    max: z.ZodNumber;
                    then: z.ZodUnion<[z.ZodObject<{
                        type: z.ZodLiteral<"CONTINUE">;
                    }, "strip", z.ZodTypeAny, {
                        type: "CONTINUE";
                    }, {
                        type: "CONTINUE";
                    }>, z.ZodObject<{
                        type: z.ZodLiteral<"COMPLETE">;
                        message: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        type: "COMPLETE";
                        message?: string | undefined;
                    }, {
                        type: "COMPLETE";
                        message?: string | undefined;
                    }>, z.ZodObject<{
                        type: z.ZodLiteral<"STOP">;
                        message: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        type: "STOP";
                        message?: string | undefined;
                    }, {
                        type: "STOP";
                        message?: string | undefined;
                    }>, z.ZodObject<{
                        type: z.ZodLiteral<"GOTO">;
                        target: z.ZodEffects<z.ZodObject<{
                            step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                            substep: z.ZodOptional<z.ZodString>;
                        }, "strip", z.ZodTypeAny, {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        }, {
                            step: string | number;
                            substep?: string | undefined;
                        }>, {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        }, {
                            step: string | number;
                            substep?: string | undefined;
                        }>;
                    }, "strip", z.ZodTypeAny, {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    }, {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    }>]>;
                }, "strip", z.ZodTypeAny, {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                }, {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                }>]>;
            }, "strip", z.ZodTypeAny, {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                };
            }, {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                };
            }>;
        }, "strip", z.ZodTypeAny, {
            pass: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                };
            };
            fail: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                };
            };
            all: true;
        }, {
            pass: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                };
            };
            fail: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                };
            };
            all: true;
        }>, z.ZodObject<{
            all: z.ZodLiteral<false>;
            pass: z.ZodObject<{
                kind: z.ZodEnum<["pass", "fail", "yes", "no"]>;
                action: z.ZodUnion<[z.ZodUnion<[z.ZodObject<{
                    type: z.ZodLiteral<"CONTINUE">;
                }, "strip", z.ZodTypeAny, {
                    type: "CONTINUE";
                }, {
                    type: "CONTINUE";
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"COMPLETE">;
                    message: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    type: "COMPLETE";
                    message?: string | undefined;
                }, {
                    type: "COMPLETE";
                    message?: string | undefined;
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"STOP">;
                    message: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    type: "STOP";
                    message?: string | undefined;
                }, {
                    type: "STOP";
                    message?: string | undefined;
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"GOTO">;
                    target: z.ZodEffects<z.ZodObject<{
                        step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                        substep: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    }, {
                        step: string | number;
                        substep?: string | undefined;
                    }>, {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    }, {
                        step: string | number;
                        substep?: string | undefined;
                    }>;
                }, "strip", z.ZodTypeAny, {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                }, {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                }>]>, z.ZodObject<{
                    type: z.ZodLiteral<"RETRY">;
                    max: z.ZodNumber;
                    then: z.ZodUnion<[z.ZodObject<{
                        type: z.ZodLiteral<"CONTINUE">;
                    }, "strip", z.ZodTypeAny, {
                        type: "CONTINUE";
                    }, {
                        type: "CONTINUE";
                    }>, z.ZodObject<{
                        type: z.ZodLiteral<"COMPLETE">;
                        message: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        type: "COMPLETE";
                        message?: string | undefined;
                    }, {
                        type: "COMPLETE";
                        message?: string | undefined;
                    }>, z.ZodObject<{
                        type: z.ZodLiteral<"STOP">;
                        message: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        type: "STOP";
                        message?: string | undefined;
                    }, {
                        type: "STOP";
                        message?: string | undefined;
                    }>, z.ZodObject<{
                        type: z.ZodLiteral<"GOTO">;
                        target: z.ZodEffects<z.ZodObject<{
                            step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                            substep: z.ZodOptional<z.ZodString>;
                        }, "strip", z.ZodTypeAny, {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        }, {
                            step: string | number;
                            substep?: string | undefined;
                        }>, {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        }, {
                            step: string | number;
                            substep?: string | undefined;
                        }>;
                    }, "strip", z.ZodTypeAny, {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    }, {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    }>]>;
                }, "strip", z.ZodTypeAny, {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                }, {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                }>]>;
            }, "strip", z.ZodTypeAny, {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                };
            }, {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                };
            }>;
            fail: z.ZodObject<{
                kind: z.ZodEnum<["pass", "fail", "yes", "no"]>;
                action: z.ZodUnion<[z.ZodUnion<[z.ZodObject<{
                    type: z.ZodLiteral<"CONTINUE">;
                }, "strip", z.ZodTypeAny, {
                    type: "CONTINUE";
                }, {
                    type: "CONTINUE";
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"COMPLETE">;
                    message: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    type: "COMPLETE";
                    message?: string | undefined;
                }, {
                    type: "COMPLETE";
                    message?: string | undefined;
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"STOP">;
                    message: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    type: "STOP";
                    message?: string | undefined;
                }, {
                    type: "STOP";
                    message?: string | undefined;
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"GOTO">;
                    target: z.ZodEffects<z.ZodObject<{
                        step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                        substep: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    }, {
                        step: string | number;
                        substep?: string | undefined;
                    }>, {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    }, {
                        step: string | number;
                        substep?: string | undefined;
                    }>;
                }, "strip", z.ZodTypeAny, {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                }, {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                }>]>, z.ZodObject<{
                    type: z.ZodLiteral<"RETRY">;
                    max: z.ZodNumber;
                    then: z.ZodUnion<[z.ZodObject<{
                        type: z.ZodLiteral<"CONTINUE">;
                    }, "strip", z.ZodTypeAny, {
                        type: "CONTINUE";
                    }, {
                        type: "CONTINUE";
                    }>, z.ZodObject<{
                        type: z.ZodLiteral<"COMPLETE">;
                        message: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        type: "COMPLETE";
                        message?: string | undefined;
                    }, {
                        type: "COMPLETE";
                        message?: string | undefined;
                    }>, z.ZodObject<{
                        type: z.ZodLiteral<"STOP">;
                        message: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        type: "STOP";
                        message?: string | undefined;
                    }, {
                        type: "STOP";
                        message?: string | undefined;
                    }>, z.ZodObject<{
                        type: z.ZodLiteral<"GOTO">;
                        target: z.ZodEffects<z.ZodObject<{
                            step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                            substep: z.ZodOptional<z.ZodString>;
                        }, "strip", z.ZodTypeAny, {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        }, {
                            step: string | number;
                            substep?: string | undefined;
                        }>, {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        }, {
                            step: string | number;
                            substep?: string | undefined;
                        }>;
                    }, "strip", z.ZodTypeAny, {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    }, {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    }>]>;
                }, "strip", z.ZodTypeAny, {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                }, {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                }>]>;
            }, "strip", z.ZodTypeAny, {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                };
            }, {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                };
            }>;
        }, "strip", z.ZodTypeAny, {
            pass: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                };
            };
            fail: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                };
            };
            all: false;
        }, {
            pass: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                };
            };
            fail: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                };
            };
            all: false;
        }>]>>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        description: string;
        isDynamic: boolean;
        isNamed: boolean;
        agentType?: string | undefined;
        workflows?: readonly string[] | undefined;
        command?: {
            code: string;
        } | undefined;
        prompt?: string | undefined;
        transitions?: {
            pass: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                };
            };
            fail: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                };
            };
            all: true;
        } | {
            pass: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                };
            };
            fail: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                };
            };
            all: false;
        } | undefined;
    }, {
        id: string;
        description: string;
        isDynamic: boolean;
        isNamed: boolean;
        agentType?: string | undefined;
        workflows?: readonly string[] | undefined;
        command?: {
            code: string;
        } | undefined;
        prompt?: string | undefined;
        transitions?: {
            pass: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                };
            };
            fail: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                };
            };
            all: true;
        } | {
            pass: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                };
            };
            fail: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                };
            };
            all: false;
        } | undefined;
    }>, "many">>>;
    workflows: z.ZodOptional<z.ZodReadonly<z.ZodArray<z.ZodString, "many">>>;
    nestedWorkflow: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    description: string;
    isDynamic: boolean;
    isNamed: boolean;
    number?: (number & z.BRAND<"StepNumber">) | undefined;
    workflows?: readonly string[] | undefined;
    command?: {
        code: string;
    } | undefined;
    prompt?: string | undefined;
    transitions?: {
        pass: {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                };
            };
        };
        fail: {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                };
            };
        };
        all: true;
    } | {
        pass: {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                };
            };
        };
        fail: {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | (number & z.BRAND<"StepNumber">);
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                };
            };
        };
        all: false;
    } | undefined;
    name?: string | undefined;
    substeps?: readonly {
        id: string;
        description: string;
        isDynamic: boolean;
        isNamed: boolean;
        agentType?: string | undefined;
        workflows?: readonly string[] | undefined;
        command?: {
            code: string;
        } | undefined;
        prompt?: string | undefined;
        transitions?: {
            pass: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                };
            };
            fail: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                };
            };
            all: true;
        } | {
            pass: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                };
            };
            fail: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                };
            };
            all: false;
        } | undefined;
    }[] | undefined;
    nestedWorkflow?: string | undefined;
}, {
    description: string;
    isDynamic: boolean;
    isNamed: boolean;
    number?: number | undefined;
    workflows?: readonly string[] | undefined;
    command?: {
        code: string;
    } | undefined;
    prompt?: string | undefined;
    transitions?: {
        pass: {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                };
            };
        };
        fail: {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                };
            };
        };
        all: true;
    } | {
        pass: {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                };
            };
        };
        fail: {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
                message?: string | undefined;
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: string | number;
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                };
            };
        };
        all: false;
    } | undefined;
    name?: string | undefined;
    substeps?: readonly {
        id: string;
        description: string;
        isDynamic: boolean;
        isNamed: boolean;
        agentType?: string | undefined;
        workflows?: readonly string[] | undefined;
        command?: {
            code: string;
        } | undefined;
        prompt?: string | undefined;
        transitions?: {
            pass: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                };
            };
            fail: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                };
            };
            all: true;
        } | {
            pass: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                };
            };
            fail: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                };
            };
            all: false;
        } | undefined;
    }[] | undefined;
    nestedWorkflow?: string | undefined;
}>;
/**
 * Zod schema for Workflow
 */
export declare const WorkflowSchema: z.ZodObject<{
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    steps: z.ZodArray<z.ZodObject<{
        number: z.ZodOptional<z.ZodBranded<z.ZodNumber, "StepNumber">>;
        name: z.ZodOptional<z.ZodString>;
        isDynamic: z.ZodBoolean;
        isNamed: z.ZodBoolean;
        description: z.ZodString;
        command: z.ZodOptional<z.ZodObject<{
            code: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            code: string;
        }, {
            code: string;
        }>>;
        prompt: z.ZodOptional<z.ZodString>;
        transitions: z.ZodOptional<z.ZodUnion<[z.ZodObject<{
            all: z.ZodLiteral<true>;
            pass: z.ZodObject<{
                kind: z.ZodEnum<["pass", "fail", "yes", "no"]>;
                action: z.ZodUnion<[z.ZodUnion<[z.ZodObject<{
                    type: z.ZodLiteral<"CONTINUE">;
                }, "strip", z.ZodTypeAny, {
                    type: "CONTINUE";
                }, {
                    type: "CONTINUE";
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"COMPLETE">;
                    message: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    type: "COMPLETE";
                    message?: string | undefined;
                }, {
                    type: "COMPLETE";
                    message?: string | undefined;
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"STOP">;
                    message: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    type: "STOP";
                    message?: string | undefined;
                }, {
                    type: "STOP";
                    message?: string | undefined;
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"GOTO">;
                    target: z.ZodEffects<z.ZodObject<{
                        step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                        substep: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    }, {
                        step: string | number;
                        substep?: string | undefined;
                    }>, {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    }, {
                        step: string | number;
                        substep?: string | undefined;
                    }>;
                }, "strip", z.ZodTypeAny, {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                }, {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                }>]>, z.ZodObject<{
                    type: z.ZodLiteral<"RETRY">;
                    max: z.ZodNumber;
                    then: z.ZodUnion<[z.ZodObject<{
                        type: z.ZodLiteral<"CONTINUE">;
                    }, "strip", z.ZodTypeAny, {
                        type: "CONTINUE";
                    }, {
                        type: "CONTINUE";
                    }>, z.ZodObject<{
                        type: z.ZodLiteral<"COMPLETE">;
                        message: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        type: "COMPLETE";
                        message?: string | undefined;
                    }, {
                        type: "COMPLETE";
                        message?: string | undefined;
                    }>, z.ZodObject<{
                        type: z.ZodLiteral<"STOP">;
                        message: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        type: "STOP";
                        message?: string | undefined;
                    }, {
                        type: "STOP";
                        message?: string | undefined;
                    }>, z.ZodObject<{
                        type: z.ZodLiteral<"GOTO">;
                        target: z.ZodEffects<z.ZodObject<{
                            step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                            substep: z.ZodOptional<z.ZodString>;
                        }, "strip", z.ZodTypeAny, {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        }, {
                            step: string | number;
                            substep?: string | undefined;
                        }>, {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        }, {
                            step: string | number;
                            substep?: string | undefined;
                        }>;
                    }, "strip", z.ZodTypeAny, {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    }, {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    }>]>;
                }, "strip", z.ZodTypeAny, {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                }, {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                }>]>;
            }, "strip", z.ZodTypeAny, {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                };
            }, {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                };
            }>;
            fail: z.ZodObject<{
                kind: z.ZodEnum<["pass", "fail", "yes", "no"]>;
                action: z.ZodUnion<[z.ZodUnion<[z.ZodObject<{
                    type: z.ZodLiteral<"CONTINUE">;
                }, "strip", z.ZodTypeAny, {
                    type: "CONTINUE";
                }, {
                    type: "CONTINUE";
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"COMPLETE">;
                    message: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    type: "COMPLETE";
                    message?: string | undefined;
                }, {
                    type: "COMPLETE";
                    message?: string | undefined;
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"STOP">;
                    message: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    type: "STOP";
                    message?: string | undefined;
                }, {
                    type: "STOP";
                    message?: string | undefined;
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"GOTO">;
                    target: z.ZodEffects<z.ZodObject<{
                        step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                        substep: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    }, {
                        step: string | number;
                        substep?: string | undefined;
                    }>, {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    }, {
                        step: string | number;
                        substep?: string | undefined;
                    }>;
                }, "strip", z.ZodTypeAny, {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                }, {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                }>]>, z.ZodObject<{
                    type: z.ZodLiteral<"RETRY">;
                    max: z.ZodNumber;
                    then: z.ZodUnion<[z.ZodObject<{
                        type: z.ZodLiteral<"CONTINUE">;
                    }, "strip", z.ZodTypeAny, {
                        type: "CONTINUE";
                    }, {
                        type: "CONTINUE";
                    }>, z.ZodObject<{
                        type: z.ZodLiteral<"COMPLETE">;
                        message: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        type: "COMPLETE";
                        message?: string | undefined;
                    }, {
                        type: "COMPLETE";
                        message?: string | undefined;
                    }>, z.ZodObject<{
                        type: z.ZodLiteral<"STOP">;
                        message: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        type: "STOP";
                        message?: string | undefined;
                    }, {
                        type: "STOP";
                        message?: string | undefined;
                    }>, z.ZodObject<{
                        type: z.ZodLiteral<"GOTO">;
                        target: z.ZodEffects<z.ZodObject<{
                            step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                            substep: z.ZodOptional<z.ZodString>;
                        }, "strip", z.ZodTypeAny, {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        }, {
                            step: string | number;
                            substep?: string | undefined;
                        }>, {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        }, {
                            step: string | number;
                            substep?: string | undefined;
                        }>;
                    }, "strip", z.ZodTypeAny, {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    }, {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    }>]>;
                }, "strip", z.ZodTypeAny, {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                }, {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                }>]>;
            }, "strip", z.ZodTypeAny, {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                };
            }, {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                };
            }>;
        }, "strip", z.ZodTypeAny, {
            pass: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                };
            };
            fail: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                };
            };
            all: true;
        }, {
            pass: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                };
            };
            fail: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                };
            };
            all: true;
        }>, z.ZodObject<{
            all: z.ZodLiteral<false>;
            pass: z.ZodObject<{
                kind: z.ZodEnum<["pass", "fail", "yes", "no"]>;
                action: z.ZodUnion<[z.ZodUnion<[z.ZodObject<{
                    type: z.ZodLiteral<"CONTINUE">;
                }, "strip", z.ZodTypeAny, {
                    type: "CONTINUE";
                }, {
                    type: "CONTINUE";
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"COMPLETE">;
                    message: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    type: "COMPLETE";
                    message?: string | undefined;
                }, {
                    type: "COMPLETE";
                    message?: string | undefined;
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"STOP">;
                    message: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    type: "STOP";
                    message?: string | undefined;
                }, {
                    type: "STOP";
                    message?: string | undefined;
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"GOTO">;
                    target: z.ZodEffects<z.ZodObject<{
                        step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                        substep: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    }, {
                        step: string | number;
                        substep?: string | undefined;
                    }>, {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    }, {
                        step: string | number;
                        substep?: string | undefined;
                    }>;
                }, "strip", z.ZodTypeAny, {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                }, {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                }>]>, z.ZodObject<{
                    type: z.ZodLiteral<"RETRY">;
                    max: z.ZodNumber;
                    then: z.ZodUnion<[z.ZodObject<{
                        type: z.ZodLiteral<"CONTINUE">;
                    }, "strip", z.ZodTypeAny, {
                        type: "CONTINUE";
                    }, {
                        type: "CONTINUE";
                    }>, z.ZodObject<{
                        type: z.ZodLiteral<"COMPLETE">;
                        message: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        type: "COMPLETE";
                        message?: string | undefined;
                    }, {
                        type: "COMPLETE";
                        message?: string | undefined;
                    }>, z.ZodObject<{
                        type: z.ZodLiteral<"STOP">;
                        message: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        type: "STOP";
                        message?: string | undefined;
                    }, {
                        type: "STOP";
                        message?: string | undefined;
                    }>, z.ZodObject<{
                        type: z.ZodLiteral<"GOTO">;
                        target: z.ZodEffects<z.ZodObject<{
                            step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                            substep: z.ZodOptional<z.ZodString>;
                        }, "strip", z.ZodTypeAny, {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        }, {
                            step: string | number;
                            substep?: string | undefined;
                        }>, {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        }, {
                            step: string | number;
                            substep?: string | undefined;
                        }>;
                    }, "strip", z.ZodTypeAny, {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    }, {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    }>]>;
                }, "strip", z.ZodTypeAny, {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                }, {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                }>]>;
            }, "strip", z.ZodTypeAny, {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                };
            }, {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                };
            }>;
            fail: z.ZodObject<{
                kind: z.ZodEnum<["pass", "fail", "yes", "no"]>;
                action: z.ZodUnion<[z.ZodUnion<[z.ZodObject<{
                    type: z.ZodLiteral<"CONTINUE">;
                }, "strip", z.ZodTypeAny, {
                    type: "CONTINUE";
                }, {
                    type: "CONTINUE";
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"COMPLETE">;
                    message: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    type: "COMPLETE";
                    message?: string | undefined;
                }, {
                    type: "COMPLETE";
                    message?: string | undefined;
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"STOP">;
                    message: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    type: "STOP";
                    message?: string | undefined;
                }, {
                    type: "STOP";
                    message?: string | undefined;
                }>, z.ZodObject<{
                    type: z.ZodLiteral<"GOTO">;
                    target: z.ZodEffects<z.ZodObject<{
                        step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                        substep: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    }, {
                        step: string | number;
                        substep?: string | undefined;
                    }>, {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    }, {
                        step: string | number;
                        substep?: string | undefined;
                    }>;
                }, "strip", z.ZodTypeAny, {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                }, {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                }>]>, z.ZodObject<{
                    type: z.ZodLiteral<"RETRY">;
                    max: z.ZodNumber;
                    then: z.ZodUnion<[z.ZodObject<{
                        type: z.ZodLiteral<"CONTINUE">;
                    }, "strip", z.ZodTypeAny, {
                        type: "CONTINUE";
                    }, {
                        type: "CONTINUE";
                    }>, z.ZodObject<{
                        type: z.ZodLiteral<"COMPLETE">;
                        message: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        type: "COMPLETE";
                        message?: string | undefined;
                    }, {
                        type: "COMPLETE";
                        message?: string | undefined;
                    }>, z.ZodObject<{
                        type: z.ZodLiteral<"STOP">;
                        message: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        type: "STOP";
                        message?: string | undefined;
                    }, {
                        type: "STOP";
                        message?: string | undefined;
                    }>, z.ZodObject<{
                        type: z.ZodLiteral<"GOTO">;
                        target: z.ZodEffects<z.ZodObject<{
                            step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                            substep: z.ZodOptional<z.ZodString>;
                        }, "strip", z.ZodTypeAny, {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        }, {
                            step: string | number;
                            substep?: string | undefined;
                        }>, {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        }, {
                            step: string | number;
                            substep?: string | undefined;
                        }>;
                    }, "strip", z.ZodTypeAny, {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    }, {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    }>]>;
                }, "strip", z.ZodTypeAny, {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                }, {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                }>]>;
            }, "strip", z.ZodTypeAny, {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                };
            }, {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                };
            }>;
        }, "strip", z.ZodTypeAny, {
            pass: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                };
            };
            fail: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                };
            };
            all: false;
        }, {
            pass: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                };
            };
            fail: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                };
            };
            all: false;
        }>]>>;
        substeps: z.ZodOptional<z.ZodReadonly<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            description: z.ZodString;
            agentType: z.ZodOptional<z.ZodString>;
            isDynamic: z.ZodBoolean;
            isNamed: z.ZodBoolean;
            workflows: z.ZodOptional<z.ZodReadonly<z.ZodArray<z.ZodString, "many">>>;
            command: z.ZodOptional<z.ZodObject<{
                code: z.ZodString;
            }, "strip", z.ZodTypeAny, {
                code: string;
            }, {
                code: string;
            }>>;
            prompt: z.ZodOptional<z.ZodString>;
            transitions: z.ZodOptional<z.ZodUnion<[z.ZodObject<{
                all: z.ZodLiteral<true>;
                pass: z.ZodObject<{
                    kind: z.ZodEnum<["pass", "fail", "yes", "no"]>;
                    action: z.ZodUnion<[z.ZodUnion<[z.ZodObject<{
                        type: z.ZodLiteral<"CONTINUE">;
                    }, "strip", z.ZodTypeAny, {
                        type: "CONTINUE";
                    }, {
                        type: "CONTINUE";
                    }>, z.ZodObject<{
                        type: z.ZodLiteral<"COMPLETE">;
                        message: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        type: "COMPLETE";
                        message?: string | undefined;
                    }, {
                        type: "COMPLETE";
                        message?: string | undefined;
                    }>, z.ZodObject<{
                        type: z.ZodLiteral<"STOP">;
                        message: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        type: "STOP";
                        message?: string | undefined;
                    }, {
                        type: "STOP";
                        message?: string | undefined;
                    }>, z.ZodObject<{
                        type: z.ZodLiteral<"GOTO">;
                        target: z.ZodEffects<z.ZodObject<{
                            step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                            substep: z.ZodOptional<z.ZodString>;
                        }, "strip", z.ZodTypeAny, {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        }, {
                            step: string | number;
                            substep?: string | undefined;
                        }>, {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        }, {
                            step: string | number;
                            substep?: string | undefined;
                        }>;
                    }, "strip", z.ZodTypeAny, {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    }, {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    }>]>, z.ZodObject<{
                        type: z.ZodLiteral<"RETRY">;
                        max: z.ZodNumber;
                        then: z.ZodUnion<[z.ZodObject<{
                            type: z.ZodLiteral<"CONTINUE">;
                        }, "strip", z.ZodTypeAny, {
                            type: "CONTINUE";
                        }, {
                            type: "CONTINUE";
                        }>, z.ZodObject<{
                            type: z.ZodLiteral<"COMPLETE">;
                            message: z.ZodOptional<z.ZodString>;
                        }, "strip", z.ZodTypeAny, {
                            type: "COMPLETE";
                            message?: string | undefined;
                        }, {
                            type: "COMPLETE";
                            message?: string | undefined;
                        }>, z.ZodObject<{
                            type: z.ZodLiteral<"STOP">;
                            message: z.ZodOptional<z.ZodString>;
                        }, "strip", z.ZodTypeAny, {
                            type: "STOP";
                            message?: string | undefined;
                        }, {
                            type: "STOP";
                            message?: string | undefined;
                        }>, z.ZodObject<{
                            type: z.ZodLiteral<"GOTO">;
                            target: z.ZodEffects<z.ZodObject<{
                                step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                                substep: z.ZodOptional<z.ZodString>;
                            }, "strip", z.ZodTypeAny, {
                                step: string | (number & z.BRAND<"StepNumber">);
                                substep?: string | undefined;
                            }, {
                                step: string | number;
                                substep?: string | undefined;
                            }>, {
                                step: string | (number & z.BRAND<"StepNumber">);
                                substep?: string | undefined;
                            }, {
                                step: string | number;
                                substep?: string | undefined;
                            }>;
                        }, "strip", z.ZodTypeAny, {
                            type: "GOTO";
                            target: {
                                step: string | (number & z.BRAND<"StepNumber">);
                                substep?: string | undefined;
                            };
                        }, {
                            type: "GOTO";
                            target: {
                                step: string | number;
                                substep?: string | undefined;
                            };
                        }>]>;
                    }, "strip", z.ZodTypeAny, {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | (number & z.BRAND<"StepNumber">);
                                substep?: string | undefined;
                            };
                        };
                    }, {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | number;
                                substep?: string | undefined;
                            };
                        };
                    }>]>;
                }, "strip", z.ZodTypeAny, {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | (number & z.BRAND<"StepNumber">);
                                substep?: string | undefined;
                            };
                        };
                    };
                }, {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | number;
                                substep?: string | undefined;
                            };
                        };
                    };
                }>;
                fail: z.ZodObject<{
                    kind: z.ZodEnum<["pass", "fail", "yes", "no"]>;
                    action: z.ZodUnion<[z.ZodUnion<[z.ZodObject<{
                        type: z.ZodLiteral<"CONTINUE">;
                    }, "strip", z.ZodTypeAny, {
                        type: "CONTINUE";
                    }, {
                        type: "CONTINUE";
                    }>, z.ZodObject<{
                        type: z.ZodLiteral<"COMPLETE">;
                        message: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        type: "COMPLETE";
                        message?: string | undefined;
                    }, {
                        type: "COMPLETE";
                        message?: string | undefined;
                    }>, z.ZodObject<{
                        type: z.ZodLiteral<"STOP">;
                        message: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        type: "STOP";
                        message?: string | undefined;
                    }, {
                        type: "STOP";
                        message?: string | undefined;
                    }>, z.ZodObject<{
                        type: z.ZodLiteral<"GOTO">;
                        target: z.ZodEffects<z.ZodObject<{
                            step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                            substep: z.ZodOptional<z.ZodString>;
                        }, "strip", z.ZodTypeAny, {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        }, {
                            step: string | number;
                            substep?: string | undefined;
                        }>, {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        }, {
                            step: string | number;
                            substep?: string | undefined;
                        }>;
                    }, "strip", z.ZodTypeAny, {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    }, {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    }>]>, z.ZodObject<{
                        type: z.ZodLiteral<"RETRY">;
                        max: z.ZodNumber;
                        then: z.ZodUnion<[z.ZodObject<{
                            type: z.ZodLiteral<"CONTINUE">;
                        }, "strip", z.ZodTypeAny, {
                            type: "CONTINUE";
                        }, {
                            type: "CONTINUE";
                        }>, z.ZodObject<{
                            type: z.ZodLiteral<"COMPLETE">;
                            message: z.ZodOptional<z.ZodString>;
                        }, "strip", z.ZodTypeAny, {
                            type: "COMPLETE";
                            message?: string | undefined;
                        }, {
                            type: "COMPLETE";
                            message?: string | undefined;
                        }>, z.ZodObject<{
                            type: z.ZodLiteral<"STOP">;
                            message: z.ZodOptional<z.ZodString>;
                        }, "strip", z.ZodTypeAny, {
                            type: "STOP";
                            message?: string | undefined;
                        }, {
                            type: "STOP";
                            message?: string | undefined;
                        }>, z.ZodObject<{
                            type: z.ZodLiteral<"GOTO">;
                            target: z.ZodEffects<z.ZodObject<{
                                step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                                substep: z.ZodOptional<z.ZodString>;
                            }, "strip", z.ZodTypeAny, {
                                step: string | (number & z.BRAND<"StepNumber">);
                                substep?: string | undefined;
                            }, {
                                step: string | number;
                                substep?: string | undefined;
                            }>, {
                                step: string | (number & z.BRAND<"StepNumber">);
                                substep?: string | undefined;
                            }, {
                                step: string | number;
                                substep?: string | undefined;
                            }>;
                        }, "strip", z.ZodTypeAny, {
                            type: "GOTO";
                            target: {
                                step: string | (number & z.BRAND<"StepNumber">);
                                substep?: string | undefined;
                            };
                        }, {
                            type: "GOTO";
                            target: {
                                step: string | number;
                                substep?: string | undefined;
                            };
                        }>]>;
                    }, "strip", z.ZodTypeAny, {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | (number & z.BRAND<"StepNumber">);
                                substep?: string | undefined;
                            };
                        };
                    }, {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | number;
                                substep?: string | undefined;
                            };
                        };
                    }>]>;
                }, "strip", z.ZodTypeAny, {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | (number & z.BRAND<"StepNumber">);
                                substep?: string | undefined;
                            };
                        };
                    };
                }, {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | number;
                                substep?: string | undefined;
                            };
                        };
                    };
                }>;
            }, "strip", z.ZodTypeAny, {
                pass: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | (number & z.BRAND<"StepNumber">);
                                substep?: string | undefined;
                            };
                        };
                    };
                };
                fail: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | (number & z.BRAND<"StepNumber">);
                                substep?: string | undefined;
                            };
                        };
                    };
                };
                all: true;
            }, {
                pass: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | number;
                                substep?: string | undefined;
                            };
                        };
                    };
                };
                fail: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | number;
                                substep?: string | undefined;
                            };
                        };
                    };
                };
                all: true;
            }>, z.ZodObject<{
                all: z.ZodLiteral<false>;
                pass: z.ZodObject<{
                    kind: z.ZodEnum<["pass", "fail", "yes", "no"]>;
                    action: z.ZodUnion<[z.ZodUnion<[z.ZodObject<{
                        type: z.ZodLiteral<"CONTINUE">;
                    }, "strip", z.ZodTypeAny, {
                        type: "CONTINUE";
                    }, {
                        type: "CONTINUE";
                    }>, z.ZodObject<{
                        type: z.ZodLiteral<"COMPLETE">;
                        message: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        type: "COMPLETE";
                        message?: string | undefined;
                    }, {
                        type: "COMPLETE";
                        message?: string | undefined;
                    }>, z.ZodObject<{
                        type: z.ZodLiteral<"STOP">;
                        message: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        type: "STOP";
                        message?: string | undefined;
                    }, {
                        type: "STOP";
                        message?: string | undefined;
                    }>, z.ZodObject<{
                        type: z.ZodLiteral<"GOTO">;
                        target: z.ZodEffects<z.ZodObject<{
                            step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                            substep: z.ZodOptional<z.ZodString>;
                        }, "strip", z.ZodTypeAny, {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        }, {
                            step: string | number;
                            substep?: string | undefined;
                        }>, {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        }, {
                            step: string | number;
                            substep?: string | undefined;
                        }>;
                    }, "strip", z.ZodTypeAny, {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    }, {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    }>]>, z.ZodObject<{
                        type: z.ZodLiteral<"RETRY">;
                        max: z.ZodNumber;
                        then: z.ZodUnion<[z.ZodObject<{
                            type: z.ZodLiteral<"CONTINUE">;
                        }, "strip", z.ZodTypeAny, {
                            type: "CONTINUE";
                        }, {
                            type: "CONTINUE";
                        }>, z.ZodObject<{
                            type: z.ZodLiteral<"COMPLETE">;
                            message: z.ZodOptional<z.ZodString>;
                        }, "strip", z.ZodTypeAny, {
                            type: "COMPLETE";
                            message?: string | undefined;
                        }, {
                            type: "COMPLETE";
                            message?: string | undefined;
                        }>, z.ZodObject<{
                            type: z.ZodLiteral<"STOP">;
                            message: z.ZodOptional<z.ZodString>;
                        }, "strip", z.ZodTypeAny, {
                            type: "STOP";
                            message?: string | undefined;
                        }, {
                            type: "STOP";
                            message?: string | undefined;
                        }>, z.ZodObject<{
                            type: z.ZodLiteral<"GOTO">;
                            target: z.ZodEffects<z.ZodObject<{
                                step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                                substep: z.ZodOptional<z.ZodString>;
                            }, "strip", z.ZodTypeAny, {
                                step: string | (number & z.BRAND<"StepNumber">);
                                substep?: string | undefined;
                            }, {
                                step: string | number;
                                substep?: string | undefined;
                            }>, {
                                step: string | (number & z.BRAND<"StepNumber">);
                                substep?: string | undefined;
                            }, {
                                step: string | number;
                                substep?: string | undefined;
                            }>;
                        }, "strip", z.ZodTypeAny, {
                            type: "GOTO";
                            target: {
                                step: string | (number & z.BRAND<"StepNumber">);
                                substep?: string | undefined;
                            };
                        }, {
                            type: "GOTO";
                            target: {
                                step: string | number;
                                substep?: string | undefined;
                            };
                        }>]>;
                    }, "strip", z.ZodTypeAny, {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | (number & z.BRAND<"StepNumber">);
                                substep?: string | undefined;
                            };
                        };
                    }, {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | number;
                                substep?: string | undefined;
                            };
                        };
                    }>]>;
                }, "strip", z.ZodTypeAny, {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | (number & z.BRAND<"StepNumber">);
                                substep?: string | undefined;
                            };
                        };
                    };
                }, {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | number;
                                substep?: string | undefined;
                            };
                        };
                    };
                }>;
                fail: z.ZodObject<{
                    kind: z.ZodEnum<["pass", "fail", "yes", "no"]>;
                    action: z.ZodUnion<[z.ZodUnion<[z.ZodObject<{
                        type: z.ZodLiteral<"CONTINUE">;
                    }, "strip", z.ZodTypeAny, {
                        type: "CONTINUE";
                    }, {
                        type: "CONTINUE";
                    }>, z.ZodObject<{
                        type: z.ZodLiteral<"COMPLETE">;
                        message: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        type: "COMPLETE";
                        message?: string | undefined;
                    }, {
                        type: "COMPLETE";
                        message?: string | undefined;
                    }>, z.ZodObject<{
                        type: z.ZodLiteral<"STOP">;
                        message: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        type: "STOP";
                        message?: string | undefined;
                    }, {
                        type: "STOP";
                        message?: string | undefined;
                    }>, z.ZodObject<{
                        type: z.ZodLiteral<"GOTO">;
                        target: z.ZodEffects<z.ZodObject<{
                            step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                            substep: z.ZodOptional<z.ZodString>;
                        }, "strip", z.ZodTypeAny, {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        }, {
                            step: string | number;
                            substep?: string | undefined;
                        }>, {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        }, {
                            step: string | number;
                            substep?: string | undefined;
                        }>;
                    }, "strip", z.ZodTypeAny, {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    }, {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    }>]>, z.ZodObject<{
                        type: z.ZodLiteral<"RETRY">;
                        max: z.ZodNumber;
                        then: z.ZodUnion<[z.ZodObject<{
                            type: z.ZodLiteral<"CONTINUE">;
                        }, "strip", z.ZodTypeAny, {
                            type: "CONTINUE";
                        }, {
                            type: "CONTINUE";
                        }>, z.ZodObject<{
                            type: z.ZodLiteral<"COMPLETE">;
                            message: z.ZodOptional<z.ZodString>;
                        }, "strip", z.ZodTypeAny, {
                            type: "COMPLETE";
                            message?: string | undefined;
                        }, {
                            type: "COMPLETE";
                            message?: string | undefined;
                        }>, z.ZodObject<{
                            type: z.ZodLiteral<"STOP">;
                            message: z.ZodOptional<z.ZodString>;
                        }, "strip", z.ZodTypeAny, {
                            type: "STOP";
                            message?: string | undefined;
                        }, {
                            type: "STOP";
                            message?: string | undefined;
                        }>, z.ZodObject<{
                            type: z.ZodLiteral<"GOTO">;
                            target: z.ZodEffects<z.ZodObject<{
                                step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">, z.ZodEffects<z.ZodString, string, string>]>;
                                substep: z.ZodOptional<z.ZodString>;
                            }, "strip", z.ZodTypeAny, {
                                step: string | (number & z.BRAND<"StepNumber">);
                                substep?: string | undefined;
                            }, {
                                step: string | number;
                                substep?: string | undefined;
                            }>, {
                                step: string | (number & z.BRAND<"StepNumber">);
                                substep?: string | undefined;
                            }, {
                                step: string | number;
                                substep?: string | undefined;
                            }>;
                        }, "strip", z.ZodTypeAny, {
                            type: "GOTO";
                            target: {
                                step: string | (number & z.BRAND<"StepNumber">);
                                substep?: string | undefined;
                            };
                        }, {
                            type: "GOTO";
                            target: {
                                step: string | number;
                                substep?: string | undefined;
                            };
                        }>]>;
                    }, "strip", z.ZodTypeAny, {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | (number & z.BRAND<"StepNumber">);
                                substep?: string | undefined;
                            };
                        };
                    }, {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | number;
                                substep?: string | undefined;
                            };
                        };
                    }>]>;
                }, "strip", z.ZodTypeAny, {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | (number & z.BRAND<"StepNumber">);
                                substep?: string | undefined;
                            };
                        };
                    };
                }, {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | number;
                                substep?: string | undefined;
                            };
                        };
                    };
                }>;
            }, "strip", z.ZodTypeAny, {
                pass: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | (number & z.BRAND<"StepNumber">);
                                substep?: string | undefined;
                            };
                        };
                    };
                };
                fail: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | (number & z.BRAND<"StepNumber">);
                                substep?: string | undefined;
                            };
                        };
                    };
                };
                all: false;
            }, {
                pass: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | number;
                                substep?: string | undefined;
                            };
                        };
                    };
                };
                fail: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | number;
                                substep?: string | undefined;
                            };
                        };
                    };
                };
                all: false;
            }>]>>;
        }, "strip", z.ZodTypeAny, {
            id: string;
            description: string;
            isDynamic: boolean;
            isNamed: boolean;
            agentType?: string | undefined;
            workflows?: readonly string[] | undefined;
            command?: {
                code: string;
            } | undefined;
            prompt?: string | undefined;
            transitions?: {
                pass: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | (number & z.BRAND<"StepNumber">);
                                substep?: string | undefined;
                            };
                        };
                    };
                };
                fail: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | (number & z.BRAND<"StepNumber">);
                                substep?: string | undefined;
                            };
                        };
                    };
                };
                all: true;
            } | {
                pass: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | (number & z.BRAND<"StepNumber">);
                                substep?: string | undefined;
                            };
                        };
                    };
                };
                fail: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | (number & z.BRAND<"StepNumber">);
                                substep?: string | undefined;
                            };
                        };
                    };
                };
                all: false;
            } | undefined;
        }, {
            id: string;
            description: string;
            isDynamic: boolean;
            isNamed: boolean;
            agentType?: string | undefined;
            workflows?: readonly string[] | undefined;
            command?: {
                code: string;
            } | undefined;
            prompt?: string | undefined;
            transitions?: {
                pass: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | number;
                                substep?: string | undefined;
                            };
                        };
                    };
                };
                fail: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | number;
                                substep?: string | undefined;
                            };
                        };
                    };
                };
                all: true;
            } | {
                pass: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | number;
                                substep?: string | undefined;
                            };
                        };
                    };
                };
                fail: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | number;
                                substep?: string | undefined;
                            };
                        };
                    };
                };
                all: false;
            } | undefined;
        }>, "many">>>;
        workflows: z.ZodOptional<z.ZodReadonly<z.ZodArray<z.ZodString, "many">>>;
        nestedWorkflow: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        description: string;
        isDynamic: boolean;
        isNamed: boolean;
        number?: (number & z.BRAND<"StepNumber">) | undefined;
        workflows?: readonly string[] | undefined;
        command?: {
            code: string;
        } | undefined;
        prompt?: string | undefined;
        transitions?: {
            pass: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                };
            };
            fail: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                };
            };
            all: true;
        } | {
            pass: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                };
            };
            fail: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                };
            };
            all: false;
        } | undefined;
        name?: string | undefined;
        substeps?: readonly {
            id: string;
            description: string;
            isDynamic: boolean;
            isNamed: boolean;
            agentType?: string | undefined;
            workflows?: readonly string[] | undefined;
            command?: {
                code: string;
            } | undefined;
            prompt?: string | undefined;
            transitions?: {
                pass: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | (number & z.BRAND<"StepNumber">);
                                substep?: string | undefined;
                            };
                        };
                    };
                };
                fail: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | (number & z.BRAND<"StepNumber">);
                                substep?: string | undefined;
                            };
                        };
                    };
                };
                all: true;
            } | {
                pass: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | (number & z.BRAND<"StepNumber">);
                                substep?: string | undefined;
                            };
                        };
                    };
                };
                fail: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | (number & z.BRAND<"StepNumber">);
                                substep?: string | undefined;
                            };
                        };
                    };
                };
                all: false;
            } | undefined;
        }[] | undefined;
        nestedWorkflow?: string | undefined;
    }, {
        description: string;
        isDynamic: boolean;
        isNamed: boolean;
        number?: number | undefined;
        workflows?: readonly string[] | undefined;
        command?: {
            code: string;
        } | undefined;
        prompt?: string | undefined;
        transitions?: {
            pass: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                };
            };
            fail: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                };
            };
            all: true;
        } | {
            pass: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                };
            };
            fail: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                };
            };
            all: false;
        } | undefined;
        name?: string | undefined;
        substeps?: readonly {
            id: string;
            description: string;
            isDynamic: boolean;
            isNamed: boolean;
            agentType?: string | undefined;
            workflows?: readonly string[] | undefined;
            command?: {
                code: string;
            } | undefined;
            prompt?: string | undefined;
            transitions?: {
                pass: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | number;
                                substep?: string | undefined;
                            };
                        };
                    };
                };
                fail: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | number;
                                substep?: string | undefined;
                            };
                        };
                    };
                };
                all: true;
            } | {
                pass: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | number;
                                substep?: string | undefined;
                            };
                        };
                    };
                };
                fail: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | number;
                                substep?: string | undefined;
                            };
                        };
                    };
                };
                all: false;
            } | undefined;
        }[] | undefined;
        nestedWorkflow?: string | undefined;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    steps: {
        description: string;
        isDynamic: boolean;
        isNamed: boolean;
        number?: (number & z.BRAND<"StepNumber">) | undefined;
        workflows?: readonly string[] | undefined;
        command?: {
            code: string;
        } | undefined;
        prompt?: string | undefined;
        transitions?: {
            pass: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                };
            };
            fail: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                };
            };
            all: true;
        } | {
            pass: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                };
            };
            fail: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | (number & z.BRAND<"StepNumber">);
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    };
                };
            };
            all: false;
        } | undefined;
        name?: string | undefined;
        substeps?: readonly {
            id: string;
            description: string;
            isDynamic: boolean;
            isNamed: boolean;
            agentType?: string | undefined;
            workflows?: readonly string[] | undefined;
            command?: {
                code: string;
            } | undefined;
            prompt?: string | undefined;
            transitions?: {
                pass: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | (number & z.BRAND<"StepNumber">);
                                substep?: string | undefined;
                            };
                        };
                    };
                };
                fail: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | (number & z.BRAND<"StepNumber">);
                                substep?: string | undefined;
                            };
                        };
                    };
                };
                all: true;
            } | {
                pass: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | (number & z.BRAND<"StepNumber">);
                                substep?: string | undefined;
                            };
                        };
                    };
                };
                fail: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | (number & z.BRAND<"StepNumber">);
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | (number & z.BRAND<"StepNumber">);
                                substep?: string | undefined;
                            };
                        };
                    };
                };
                all: false;
            } | undefined;
        }[] | undefined;
        nestedWorkflow?: string | undefined;
    }[];
    description?: string | undefined;
    title?: string | undefined;
}, {
    steps: {
        description: string;
        isDynamic: boolean;
        isNamed: boolean;
        number?: number | undefined;
        workflows?: readonly string[] | undefined;
        command?: {
            code: string;
        } | undefined;
        prompt?: string | undefined;
        transitions?: {
            pass: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                };
            };
            fail: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                };
            };
            all: true;
        } | {
            pass: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                };
            };
            fail: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                    message?: string | undefined;
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: string | number;
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    };
                };
            };
            all: false;
        } | undefined;
        name?: string | undefined;
        substeps?: readonly {
            id: string;
            description: string;
            isDynamic: boolean;
            isNamed: boolean;
            agentType?: string | undefined;
            workflows?: readonly string[] | undefined;
            command?: {
                code: string;
            } | undefined;
            prompt?: string | undefined;
            transitions?: {
                pass: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | number;
                                substep?: string | undefined;
                            };
                        };
                    };
                };
                fail: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | number;
                                substep?: string | undefined;
                            };
                        };
                    };
                };
                all: true;
            } | {
                pass: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | number;
                                substep?: string | undefined;
                            };
                        };
                    };
                };
                fail: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                        message?: string | undefined;
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: string | number;
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                            message?: string | undefined;
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: string | number;
                                substep?: string | undefined;
                            };
                        };
                    };
                };
                all: false;
            } | undefined;
        }[] | undefined;
        nestedWorkflow?: string | undefined;
    }[];
    description?: string | undefined;
    title?: string | undefined;
}>;
//# sourceMappingURL=schemas.d.ts.map