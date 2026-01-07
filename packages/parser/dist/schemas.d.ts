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
    prompted: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    code: string;
    prompted?: boolean | undefined;
}, {
    code: string;
    prompted?: boolean | undefined;
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
 * Zod schema for StepId
 */
export declare const StepIdSchema: z.ZodEffects<z.ZodObject<{
    step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
    substep: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
    substep?: string | undefined;
}, {
    step: number | "{N}" | "NEXT";
    substep?: string | undefined;
}>, {
    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
    substep?: string | undefined;
}, {
    step: number | "{N}" | "NEXT";
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
}, "strip", z.ZodTypeAny, {
    type: "COMPLETE";
}, {
    type: "COMPLETE";
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
        step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
        substep: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
        substep?: string | undefined;
    }, {
        step: number | "{N}" | "NEXT";
        substep?: string | undefined;
    }>, {
        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
        substep?: string | undefined;
    }, {
        step: number | "{N}" | "NEXT";
        substep?: string | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    type: "GOTO";
    target: {
        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
        substep?: string | undefined;
    };
}, {
    type: "GOTO";
    target: {
        step: number | "{N}" | "NEXT";
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
}, "strip", z.ZodTypeAny, {
    type: "COMPLETE";
}, {
    type: "COMPLETE";
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
        step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
        substep: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
        substep?: string | undefined;
    }, {
        step: number | "{N}" | "NEXT";
        substep?: string | undefined;
    }>, {
        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
        substep?: string | undefined;
    }, {
        step: number | "{N}" | "NEXT";
        substep?: string | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    type: "GOTO";
    target: {
        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
        substep?: string | undefined;
    };
}, {
    type: "GOTO";
    target: {
        step: number | "{N}" | "NEXT";
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
    }, "strip", z.ZodTypeAny, {
        type: "COMPLETE";
    }, {
        type: "COMPLETE";
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
            step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
            substep: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
            substep?: string | undefined;
        }, {
            step: number | "{N}" | "NEXT";
            substep?: string | undefined;
        }>, {
            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
            substep?: string | undefined;
        }, {
            step: number | "{N}" | "NEXT";
            substep?: string | undefined;
        }>;
    }, "strip", z.ZodTypeAny, {
        type: "GOTO";
        target: {
            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
            substep?: string | undefined;
        };
    }, {
        type: "GOTO";
        target: {
            step: number | "{N}" | "NEXT";
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
    } | {
        type: "STOP";
        message?: string | undefined;
    } | {
        type: "GOTO";
        target: {
            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
    } | {
        type: "STOP";
        message?: string | undefined;
    } | {
        type: "GOTO";
        target: {
            step: number | "{N}" | "NEXT";
            substep?: string | undefined;
        };
    };
}>]>;
export type Action = Readonly<z.output<typeof ActionSchema>>;
/**
 * Transition object with kind information
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
    }, "strip", z.ZodTypeAny, {
        type: "COMPLETE";
    }, {
        type: "COMPLETE";
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
            step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
            substep: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
            substep?: string | undefined;
        }, {
            step: number | "{N}" | "NEXT";
            substep?: string | undefined;
        }>, {
            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
            substep?: string | undefined;
        }, {
            step: number | "{N}" | "NEXT";
            substep?: string | undefined;
        }>;
    }, "strip", z.ZodTypeAny, {
        type: "GOTO";
        target: {
            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
            substep?: string | undefined;
        };
    }, {
        type: "GOTO";
        target: {
            step: number | "{N}" | "NEXT";
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
        }, "strip", z.ZodTypeAny, {
            type: "COMPLETE";
        }, {
            type: "COMPLETE";
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
                step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                substep: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                substep?: string | undefined;
            }, {
                step: number | "{N}" | "NEXT";
                substep?: string | undefined;
            }>, {
                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                substep?: string | undefined;
            }, {
                step: number | "{N}" | "NEXT";
                substep?: string | undefined;
            }>;
        }, "strip", z.ZodTypeAny, {
            type: "GOTO";
            target: {
                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                substep?: string | undefined;
            };
        }, {
            type: "GOTO";
            target: {
                step: number | "{N}" | "NEXT";
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
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: number | "{N}" | "NEXT";
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
    } | {
        type: "STOP";
        message?: string | undefined;
    } | {
        type: "GOTO";
        target: {
            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
            substep?: string | undefined;
        };
    } | {
        type: "RETRY";
        max: number;
        then: {
            type: "CONTINUE";
        } | {
            type: "COMPLETE";
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
    } | {
        type: "STOP";
        message?: string | undefined;
    } | {
        type: "GOTO";
        target: {
            step: number | "{N}" | "NEXT";
            substep?: string | undefined;
        };
    } | {
        type: "RETRY";
        max: number;
        then: {
            type: "CONTINUE";
        } | {
            type: "COMPLETE";
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: number | "{N}" | "NEXT";
                substep?: string | undefined;
            };
        };
    };
}>;
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
        }, "strip", z.ZodTypeAny, {
            type: "COMPLETE";
        }, {
            type: "COMPLETE";
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
                step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                substep: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                substep?: string | undefined;
            }, {
                step: number | "{N}" | "NEXT";
                substep?: string | undefined;
            }>, {
                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                substep?: string | undefined;
            }, {
                step: number | "{N}" | "NEXT";
                substep?: string | undefined;
            }>;
        }, "strip", z.ZodTypeAny, {
            type: "GOTO";
            target: {
                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                substep?: string | undefined;
            };
        }, {
            type: "GOTO";
            target: {
                step: number | "{N}" | "NEXT";
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
            }, "strip", z.ZodTypeAny, {
                type: "COMPLETE";
            }, {
                type: "COMPLETE";
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
                    step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                    substep: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                }, {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                }>, {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                }, {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                }>;
            }, "strip", z.ZodTypeAny, {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            }, {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
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
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                substep?: string | undefined;
            };
        } | {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: number | "{N}" | "NEXT";
                substep?: string | undefined;
            };
        } | {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
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
        }, "strip", z.ZodTypeAny, {
            type: "COMPLETE";
        }, {
            type: "COMPLETE";
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
                step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                substep: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                substep?: string | undefined;
            }, {
                step: number | "{N}" | "NEXT";
                substep?: string | undefined;
            }>, {
                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                substep?: string | undefined;
            }, {
                step: number | "{N}" | "NEXT";
                substep?: string | undefined;
            }>;
        }, "strip", z.ZodTypeAny, {
            type: "GOTO";
            target: {
                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                substep?: string | undefined;
            };
        }, {
            type: "GOTO";
            target: {
                step: number | "{N}" | "NEXT";
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
            }, "strip", z.ZodTypeAny, {
                type: "COMPLETE";
            }, {
                type: "COMPLETE";
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
                    step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                    substep: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                }, {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                }>, {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                }, {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                }>;
            }, "strip", z.ZodTypeAny, {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            }, {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
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
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                substep?: string | undefined;
            };
        } | {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: number | "{N}" | "NEXT";
                substep?: string | undefined;
            };
        } | {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
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
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                substep?: string | undefined;
            };
        } | {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                substep?: string | undefined;
            };
        } | {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: number | "{N}" | "NEXT";
                substep?: string | undefined;
            };
        } | {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
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
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: number | "{N}" | "NEXT";
                substep?: string | undefined;
            };
        } | {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
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
        }, "strip", z.ZodTypeAny, {
            type: "COMPLETE";
        }, {
            type: "COMPLETE";
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
                step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                substep: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                substep?: string | undefined;
            }, {
                step: number | "{N}" | "NEXT";
                substep?: string | undefined;
            }>, {
                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                substep?: string | undefined;
            }, {
                step: number | "{N}" | "NEXT";
                substep?: string | undefined;
            }>;
        }, "strip", z.ZodTypeAny, {
            type: "GOTO";
            target: {
                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                substep?: string | undefined;
            };
        }, {
            type: "GOTO";
            target: {
                step: number | "{N}" | "NEXT";
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
            }, "strip", z.ZodTypeAny, {
                type: "COMPLETE";
            }, {
                type: "COMPLETE";
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
                    step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                    substep: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                }, {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                }>, {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                }, {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                }>;
            }, "strip", z.ZodTypeAny, {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            }, {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
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
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                substep?: string | undefined;
            };
        } | {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: number | "{N}" | "NEXT";
                substep?: string | undefined;
            };
        } | {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
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
        }, "strip", z.ZodTypeAny, {
            type: "COMPLETE";
        }, {
            type: "COMPLETE";
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
                step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                substep: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                substep?: string | undefined;
            }, {
                step: number | "{N}" | "NEXT";
                substep?: string | undefined;
            }>, {
                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                substep?: string | undefined;
            }, {
                step: number | "{N}" | "NEXT";
                substep?: string | undefined;
            }>;
        }, "strip", z.ZodTypeAny, {
            type: "GOTO";
            target: {
                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                substep?: string | undefined;
            };
        }, {
            type: "GOTO";
            target: {
                step: number | "{N}" | "NEXT";
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
            }, "strip", z.ZodTypeAny, {
                type: "COMPLETE";
            }, {
                type: "COMPLETE";
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
                    step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                    substep: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                }, {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                }>, {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                }, {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                }>;
            }, "strip", z.ZodTypeAny, {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            }, {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
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
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                substep?: string | undefined;
            };
        } | {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: number | "{N}" | "NEXT";
                substep?: string | undefined;
            };
        } | {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
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
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                substep?: string | undefined;
            };
        } | {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                substep?: string | undefined;
            };
        } | {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: number | "{N}" | "NEXT";
                substep?: string | undefined;
            };
        } | {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
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
        } | {
            type: "STOP";
            message?: string | undefined;
        } | {
            type: "GOTO";
            target: {
                step: number | "{N}" | "NEXT";
                substep?: string | undefined;
            };
        } | {
            type: "RETRY";
            max: number;
            then: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
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
    workflows: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    command: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        prompted: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        code: string;
        prompted?: boolean | undefined;
    }, {
        code: string;
        prompted?: boolean | undefined;
    }>>;
    prompts: z.ZodArray<z.ZodObject<{
        text: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        text: string;
    }, {
        text: string;
    }>, "many">;
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
            }, "strip", z.ZodTypeAny, {
                type: "COMPLETE";
            }, {
                type: "COMPLETE";
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
                    step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                    substep: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                }, {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                }>, {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                }, {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                }>;
            }, "strip", z.ZodTypeAny, {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            }, {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
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
                }, "strip", z.ZodTypeAny, {
                    type: "COMPLETE";
                }, {
                    type: "COMPLETE";
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
                        step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                        substep: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }, {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }>, {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }, {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }>;
                }, "strip", z.ZodTypeAny, {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                }, {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
            }, "strip", z.ZodTypeAny, {
                type: "COMPLETE";
            }, {
                type: "COMPLETE";
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
                    step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                    substep: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                }, {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                }>, {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                }, {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                }>;
            }, "strip", z.ZodTypeAny, {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            }, {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
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
                }, "strip", z.ZodTypeAny, {
                    type: "COMPLETE";
                }, {
                    type: "COMPLETE";
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
                        step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                        substep: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }, {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }>, {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }, {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }>;
                }, "strip", z.ZodTypeAny, {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                }, {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
            }, "strip", z.ZodTypeAny, {
                type: "COMPLETE";
            }, {
                type: "COMPLETE";
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
                    step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                    substep: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                }, {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                }>, {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                }, {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                }>;
            }, "strip", z.ZodTypeAny, {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            }, {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
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
                }, "strip", z.ZodTypeAny, {
                    type: "COMPLETE";
                }, {
                    type: "COMPLETE";
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
                        step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                        substep: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }, {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }>, {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }, {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }>;
                }, "strip", z.ZodTypeAny, {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                }, {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
            }, "strip", z.ZodTypeAny, {
                type: "COMPLETE";
            }, {
                type: "COMPLETE";
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
                    step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                    substep: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                }, {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                }>, {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                }, {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                }>;
            }, "strip", z.ZodTypeAny, {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            }, {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
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
                }, "strip", z.ZodTypeAny, {
                    type: "COMPLETE";
                }, {
                    type: "COMPLETE";
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
                        step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                        substep: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }, {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }>, {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }, {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }>;
                }, "strip", z.ZodTypeAny, {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                }, {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
    prompts: {
        text: string;
    }[];
    agentType?: string | undefined;
    workflows?: string[] | undefined;
    command?: {
        code: string;
        prompted?: boolean | undefined;
    } | undefined;
    transitions?: {
        pass: {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
    prompts: {
        text: string;
    }[];
    agentType?: string | undefined;
    workflows?: string[] | undefined;
    command?: {
        code: string;
        prompted?: boolean | undefined;
    } | undefined;
    transitions?: {
        pass: {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
    isDynamic: z.ZodBoolean;
    description: z.ZodString;
    command: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        prompted: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        code: string;
        prompted?: boolean | undefined;
    }, {
        code: string;
        prompted?: boolean | undefined;
    }>>;
    prompts: z.ZodArray<z.ZodObject<{
        text: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        text: string;
    }, {
        text: string;
    }>, "many">;
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
            }, "strip", z.ZodTypeAny, {
                type: "COMPLETE";
            }, {
                type: "COMPLETE";
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
                    step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                    substep: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                }, {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                }>, {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                }, {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                }>;
            }, "strip", z.ZodTypeAny, {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            }, {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
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
                }, "strip", z.ZodTypeAny, {
                    type: "COMPLETE";
                }, {
                    type: "COMPLETE";
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
                        step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                        substep: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }, {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }>, {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }, {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }>;
                }, "strip", z.ZodTypeAny, {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                }, {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
            }, "strip", z.ZodTypeAny, {
                type: "COMPLETE";
            }, {
                type: "COMPLETE";
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
                    step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                    substep: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                }, {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                }>, {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                }, {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                }>;
            }, "strip", z.ZodTypeAny, {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            }, {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
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
                }, "strip", z.ZodTypeAny, {
                    type: "COMPLETE";
                }, {
                    type: "COMPLETE";
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
                        step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                        substep: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }, {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }>, {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }, {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }>;
                }, "strip", z.ZodTypeAny, {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                }, {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
            }, "strip", z.ZodTypeAny, {
                type: "COMPLETE";
            }, {
                type: "COMPLETE";
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
                    step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                    substep: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                }, {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                }>, {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                }, {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                }>;
            }, "strip", z.ZodTypeAny, {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            }, {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
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
                }, "strip", z.ZodTypeAny, {
                    type: "COMPLETE";
                }, {
                    type: "COMPLETE";
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
                        step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                        substep: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }, {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }>, {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }, {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }>;
                }, "strip", z.ZodTypeAny, {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                }, {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
            }, "strip", z.ZodTypeAny, {
                type: "COMPLETE";
            }, {
                type: "COMPLETE";
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
                    step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                    substep: z.ZodOptional<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                }, {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                }>, {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                }, {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                }>;
            }, "strip", z.ZodTypeAny, {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            }, {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
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
                }, "strip", z.ZodTypeAny, {
                    type: "COMPLETE";
                }, {
                    type: "COMPLETE";
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
                        step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                        substep: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }, {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }>, {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }, {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }>;
                }, "strip", z.ZodTypeAny, {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                }, {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                };
            };
        };
        all: false;
    }>]>>;
    substeps: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        description: z.ZodString;
        agentType: z.ZodOptional<z.ZodString>;
        isDynamic: z.ZodBoolean;
        workflows: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        command: z.ZodOptional<z.ZodObject<{
            code: z.ZodString;
            prompted: z.ZodOptional<z.ZodBoolean>;
        }, "strip", z.ZodTypeAny, {
            code: string;
            prompted?: boolean | undefined;
        }, {
            code: string;
            prompted?: boolean | undefined;
        }>>;
        prompts: z.ZodArray<z.ZodObject<{
            text: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            text: string;
        }, {
            text: string;
        }>, "many">;
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
                }, "strip", z.ZodTypeAny, {
                    type: "COMPLETE";
                }, {
                    type: "COMPLETE";
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
                        step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                        substep: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }, {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }>, {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }, {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }>;
                }, "strip", z.ZodTypeAny, {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                }, {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
                    }, "strip", z.ZodTypeAny, {
                        type: "COMPLETE";
                    }, {
                        type: "COMPLETE";
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
                            step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                            substep: z.ZodOptional<z.ZodString>;
                        }, "strip", z.ZodTypeAny, {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }, {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }>, {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }, {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }>;
                    }, "strip", z.ZodTypeAny, {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    }, {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                }, "strip", z.ZodTypeAny, {
                    type: "COMPLETE";
                }, {
                    type: "COMPLETE";
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
                        step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                        substep: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }, {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }>, {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }, {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }>;
                }, "strip", z.ZodTypeAny, {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                }, {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
                    }, "strip", z.ZodTypeAny, {
                        type: "COMPLETE";
                    }, {
                        type: "COMPLETE";
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
                            step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                            substep: z.ZodOptional<z.ZodString>;
                        }, "strip", z.ZodTypeAny, {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }, {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }>, {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }, {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }>;
                    }, "strip", z.ZodTypeAny, {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    }, {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                }, "strip", z.ZodTypeAny, {
                    type: "COMPLETE";
                }, {
                    type: "COMPLETE";
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
                        step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                        substep: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }, {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }>, {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }, {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }>;
                }, "strip", z.ZodTypeAny, {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                }, {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
                    }, "strip", z.ZodTypeAny, {
                        type: "COMPLETE";
                    }, {
                        type: "COMPLETE";
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
                            step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                            substep: z.ZodOptional<z.ZodString>;
                        }, "strip", z.ZodTypeAny, {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }, {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }>, {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }, {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }>;
                    }, "strip", z.ZodTypeAny, {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    }, {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                }, "strip", z.ZodTypeAny, {
                    type: "COMPLETE";
                }, {
                    type: "COMPLETE";
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
                        step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                        substep: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }, {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }>, {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }, {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }>;
                }, "strip", z.ZodTypeAny, {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                }, {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
                    }, "strip", z.ZodTypeAny, {
                        type: "COMPLETE";
                    }, {
                        type: "COMPLETE";
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
                            step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                            substep: z.ZodOptional<z.ZodString>;
                        }, "strip", z.ZodTypeAny, {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }, {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }>, {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }, {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }>;
                    }, "strip", z.ZodTypeAny, {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    }, {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
        prompts: {
            text: string;
        }[];
        agentType?: string | undefined;
        workflows?: string[] | undefined;
        command?: {
            code: string;
            prompted?: boolean | undefined;
        } | undefined;
        transitions?: {
            pass: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
        prompts: {
            text: string;
        }[];
        agentType?: string | undefined;
        workflows?: string[] | undefined;
        command?: {
            code: string;
            prompted?: boolean | undefined;
        } | undefined;
        transitions?: {
            pass: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    };
                };
            };
            all: false;
        } | undefined;
    }>, "many">>;
    workflows: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    nestedWorkflow: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    description: string;
    isDynamic: boolean;
    prompts: {
        text: string;
    }[];
    number?: (number & z.BRAND<"StepNumber">) | undefined;
    workflows?: string[] | undefined;
    command?: {
        code: string;
        prompted?: boolean | undefined;
    } | undefined;
    transitions?: {
        pass: {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                };
            };
        };
        all: false;
    } | undefined;
    substeps?: {
        id: string;
        description: string;
        isDynamic: boolean;
        prompts: {
            text: string;
        }[];
        agentType?: string | undefined;
        workflows?: string[] | undefined;
        command?: {
            code: string;
            prompted?: boolean | undefined;
        } | undefined;
        transitions?: {
            pass: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
    prompts: {
        text: string;
    }[];
    number?: number | undefined;
    workflows?: string[] | undefined;
    command?: {
        code: string;
        prompted?: boolean | undefined;
    } | undefined;
    transitions?: {
        pass: {
            kind: "pass" | "fail" | "yes" | "no";
            action: {
                type: "CONTINUE";
            } | {
                type: "COMPLETE";
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
            } | {
                type: "STOP";
                message?: string | undefined;
            } | {
                type: "GOTO";
                target: {
                    step: number | "{N}" | "NEXT";
                    substep?: string | undefined;
                };
            } | {
                type: "RETRY";
                max: number;
                then: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                };
            };
        };
        all: false;
    } | undefined;
    substeps?: {
        id: string;
        description: string;
        isDynamic: boolean;
        prompts: {
            text: string;
        }[];
        agentType?: string | undefined;
        workflows?: string[] | undefined;
        command?: {
            code: string;
            prompted?: boolean | undefined;
        } | undefined;
        transitions?: {
            pass: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
        isDynamic: z.ZodBoolean;
        description: z.ZodString;
        command: z.ZodOptional<z.ZodObject<{
            code: z.ZodString;
            prompted: z.ZodOptional<z.ZodBoolean>;
        }, "strip", z.ZodTypeAny, {
            code: string;
            prompted?: boolean | undefined;
        }, {
            code: string;
            prompted?: boolean | undefined;
        }>>;
        prompts: z.ZodArray<z.ZodObject<{
            text: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            text: string;
        }, {
            text: string;
        }>, "many">;
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
                }, "strip", z.ZodTypeAny, {
                    type: "COMPLETE";
                }, {
                    type: "COMPLETE";
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
                        step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                        substep: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }, {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }>, {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }, {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }>;
                }, "strip", z.ZodTypeAny, {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                }, {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
                    }, "strip", z.ZodTypeAny, {
                        type: "COMPLETE";
                    }, {
                        type: "COMPLETE";
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
                            step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                            substep: z.ZodOptional<z.ZodString>;
                        }, "strip", z.ZodTypeAny, {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }, {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }>, {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }, {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }>;
                    }, "strip", z.ZodTypeAny, {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    }, {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                }, "strip", z.ZodTypeAny, {
                    type: "COMPLETE";
                }, {
                    type: "COMPLETE";
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
                        step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                        substep: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }, {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }>, {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }, {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }>;
                }, "strip", z.ZodTypeAny, {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                }, {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
                    }, "strip", z.ZodTypeAny, {
                        type: "COMPLETE";
                    }, {
                        type: "COMPLETE";
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
                            step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                            substep: z.ZodOptional<z.ZodString>;
                        }, "strip", z.ZodTypeAny, {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }, {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }>, {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }, {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }>;
                    }, "strip", z.ZodTypeAny, {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    }, {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                }, "strip", z.ZodTypeAny, {
                    type: "COMPLETE";
                }, {
                    type: "COMPLETE";
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
                        step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                        substep: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }, {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }>, {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }, {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }>;
                }, "strip", z.ZodTypeAny, {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                }, {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
                    }, "strip", z.ZodTypeAny, {
                        type: "COMPLETE";
                    }, {
                        type: "COMPLETE";
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
                            step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                            substep: z.ZodOptional<z.ZodString>;
                        }, "strip", z.ZodTypeAny, {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }, {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }>, {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }, {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }>;
                    }, "strip", z.ZodTypeAny, {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    }, {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                }, "strip", z.ZodTypeAny, {
                    type: "COMPLETE";
                }, {
                    type: "COMPLETE";
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
                        step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                        substep: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }, {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }>, {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }, {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    }>;
                }, "strip", z.ZodTypeAny, {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                }, {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
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
                    }, "strip", z.ZodTypeAny, {
                        type: "COMPLETE";
                    }, {
                        type: "COMPLETE";
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
                            step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                            substep: z.ZodOptional<z.ZodString>;
                        }, "strip", z.ZodTypeAny, {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }, {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }>, {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }, {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }>;
                    }, "strip", z.ZodTypeAny, {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    }, {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    };
                };
            };
            all: false;
        }>]>>;
        substeps: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            description: z.ZodString;
            agentType: z.ZodOptional<z.ZodString>;
            isDynamic: z.ZodBoolean;
            workflows: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            command: z.ZodOptional<z.ZodObject<{
                code: z.ZodString;
                prompted: z.ZodOptional<z.ZodBoolean>;
            }, "strip", z.ZodTypeAny, {
                code: string;
                prompted?: boolean | undefined;
            }, {
                code: string;
                prompted?: boolean | undefined;
            }>>;
            prompts: z.ZodArray<z.ZodObject<{
                text: z.ZodString;
            }, "strip", z.ZodTypeAny, {
                text: string;
            }, {
                text: string;
            }>, "many">;
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
                    }, "strip", z.ZodTypeAny, {
                        type: "COMPLETE";
                    }, {
                        type: "COMPLETE";
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
                            step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                            substep: z.ZodOptional<z.ZodString>;
                        }, "strip", z.ZodTypeAny, {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }, {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }>, {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }, {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }>;
                    }, "strip", z.ZodTypeAny, {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    }, {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                        }, "strip", z.ZodTypeAny, {
                            type: "COMPLETE";
                        }, {
                            type: "COMPLETE";
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
                                step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                                substep: z.ZodOptional<z.ZodString>;
                            }, "strip", z.ZodTypeAny, {
                                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                                substep?: string | undefined;
                            }, {
                                step: number | "{N}" | "NEXT";
                                substep?: string | undefined;
                            }>, {
                                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                                substep?: string | undefined;
                            }, {
                                step: number | "{N}" | "NEXT";
                                substep?: string | undefined;
                            }>;
                        }, "strip", z.ZodTypeAny, {
                            type: "GOTO";
                            target: {
                                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                                substep?: string | undefined;
                            };
                        }, {
                            type: "GOTO";
                            target: {
                                step: number | "{N}" | "NEXT";
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
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: number | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: number | "{N}" | "NEXT";
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
                    }, "strip", z.ZodTypeAny, {
                        type: "COMPLETE";
                    }, {
                        type: "COMPLETE";
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
                            step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                            substep: z.ZodOptional<z.ZodString>;
                        }, "strip", z.ZodTypeAny, {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }, {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }>, {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }, {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }>;
                    }, "strip", z.ZodTypeAny, {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    }, {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                        }, "strip", z.ZodTypeAny, {
                            type: "COMPLETE";
                        }, {
                            type: "COMPLETE";
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
                                step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                                substep: z.ZodOptional<z.ZodString>;
                            }, "strip", z.ZodTypeAny, {
                                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                                substep?: string | undefined;
                            }, {
                                step: number | "{N}" | "NEXT";
                                substep?: string | undefined;
                            }>, {
                                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                                substep?: string | undefined;
                            }, {
                                step: number | "{N}" | "NEXT";
                                substep?: string | undefined;
                            }>;
                        }, "strip", z.ZodTypeAny, {
                            type: "GOTO";
                            target: {
                                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                                substep?: string | undefined;
                            };
                        }, {
                            type: "GOTO";
                            target: {
                                step: number | "{N}" | "NEXT";
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
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: number | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: number | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: number | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: number | "{N}" | "NEXT";
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
                    }, "strip", z.ZodTypeAny, {
                        type: "COMPLETE";
                    }, {
                        type: "COMPLETE";
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
                            step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                            substep: z.ZodOptional<z.ZodString>;
                        }, "strip", z.ZodTypeAny, {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }, {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }>, {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }, {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }>;
                    }, "strip", z.ZodTypeAny, {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    }, {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                        }, "strip", z.ZodTypeAny, {
                            type: "COMPLETE";
                        }, {
                            type: "COMPLETE";
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
                                step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                                substep: z.ZodOptional<z.ZodString>;
                            }, "strip", z.ZodTypeAny, {
                                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                                substep?: string | undefined;
                            }, {
                                step: number | "{N}" | "NEXT";
                                substep?: string | undefined;
                            }>, {
                                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                                substep?: string | undefined;
                            }, {
                                step: number | "{N}" | "NEXT";
                                substep?: string | undefined;
                            }>;
                        }, "strip", z.ZodTypeAny, {
                            type: "GOTO";
                            target: {
                                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                                substep?: string | undefined;
                            };
                        }, {
                            type: "GOTO";
                            target: {
                                step: number | "{N}" | "NEXT";
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
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: number | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: number | "{N}" | "NEXT";
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
                    }, "strip", z.ZodTypeAny, {
                        type: "COMPLETE";
                    }, {
                        type: "COMPLETE";
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
                            step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                            substep: z.ZodOptional<z.ZodString>;
                        }, "strip", z.ZodTypeAny, {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }, {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }>, {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }, {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        }>;
                    }, "strip", z.ZodTypeAny, {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    }, {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                        }, "strip", z.ZodTypeAny, {
                            type: "COMPLETE";
                        }, {
                            type: "COMPLETE";
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
                                step: z.ZodUnion<[z.ZodBranded<z.ZodNumber, "StepNumber">, z.ZodLiteral<"{N}">, z.ZodLiteral<"NEXT">]>;
                                substep: z.ZodOptional<z.ZodString>;
                            }, "strip", z.ZodTypeAny, {
                                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                                substep?: string | undefined;
                            }, {
                                step: number | "{N}" | "NEXT";
                                substep?: string | undefined;
                            }>, {
                                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                                substep?: string | undefined;
                            }, {
                                step: number | "{N}" | "NEXT";
                                substep?: string | undefined;
                            }>;
                        }, "strip", z.ZodTypeAny, {
                            type: "GOTO";
                            target: {
                                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                                substep?: string | undefined;
                            };
                        }, {
                            type: "GOTO";
                            target: {
                                step: number | "{N}" | "NEXT";
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
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: number | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: number | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: number | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: number | "{N}" | "NEXT";
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
            prompts: {
                text: string;
            }[];
            agentType?: string | undefined;
            workflows?: string[] | undefined;
            command?: {
                code: string;
                prompted?: boolean | undefined;
            } | undefined;
            transitions?: {
                pass: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
            prompts: {
                text: string;
            }[];
            agentType?: string | undefined;
            workflows?: string[] | undefined;
            command?: {
                code: string;
                prompted?: boolean | undefined;
            } | undefined;
            transitions?: {
                pass: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: number | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: number | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: number | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: number | "{N}" | "NEXT";
                                substep?: string | undefined;
                            };
                        };
                    };
                };
                all: false;
            } | undefined;
        }>, "many">>;
        workflows: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        nestedWorkflow: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        description: string;
        isDynamic: boolean;
        prompts: {
            text: string;
        }[];
        number?: (number & z.BRAND<"StepNumber">) | undefined;
        workflows?: string[] | undefined;
        command?: {
            code: string;
            prompted?: boolean | undefined;
        } | undefined;
        transitions?: {
            pass: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    };
                };
            };
            all: false;
        } | undefined;
        substeps?: {
            id: string;
            description: string;
            isDynamic: boolean;
            prompts: {
                text: string;
            }[];
            agentType?: string | undefined;
            workflows?: string[] | undefined;
            command?: {
                code: string;
                prompted?: boolean | undefined;
            } | undefined;
            transitions?: {
                pass: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
        prompts: {
            text: string;
        }[];
        number?: number | undefined;
        workflows?: string[] | undefined;
        command?: {
            code: string;
            prompted?: boolean | undefined;
        } | undefined;
        transitions?: {
            pass: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    };
                };
            };
            all: false;
        } | undefined;
        substeps?: {
            id: string;
            description: string;
            isDynamic: boolean;
            prompts: {
                text: string;
            }[];
            agentType?: string | undefined;
            workflows?: string[] | undefined;
            command?: {
                code: string;
                prompted?: boolean | undefined;
            } | undefined;
            transitions?: {
                pass: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: number | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: number | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: number | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: number | "{N}" | "NEXT";
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
        prompts: {
            text: string;
        }[];
        number?: (number & z.BRAND<"StepNumber">) | undefined;
        workflows?: string[] | undefined;
        command?: {
            code: string;
            prompted?: boolean | undefined;
        } | undefined;
        transitions?: {
            pass: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    };
                };
            };
            all: false;
        } | undefined;
        substeps?: {
            id: string;
            description: string;
            isDynamic: boolean;
            prompts: {
                text: string;
            }[];
            agentType?: string | undefined;
            workflows?: string[] | undefined;
            command?: {
                code: string;
                prompted?: boolean | undefined;
            } | undefined;
            transitions?: {
                pass: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: (number & z.BRAND<"StepNumber">) | "{N}" | "NEXT";
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
        prompts: {
            text: string;
        }[];
        number?: number | undefined;
        workflows?: string[] | undefined;
        command?: {
            code: string;
            prompted?: boolean | undefined;
        } | undefined;
        transitions?: {
            pass: {
                kind: "pass" | "fail" | "yes" | "no";
                action: {
                    type: "CONTINUE";
                } | {
                    type: "COMPLETE";
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
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
                } | {
                    type: "STOP";
                    message?: string | undefined;
                } | {
                    type: "GOTO";
                    target: {
                        step: number | "{N}" | "NEXT";
                        substep?: string | undefined;
                    };
                } | {
                    type: "RETRY";
                    max: number;
                    then: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    };
                };
            };
            all: false;
        } | undefined;
        substeps?: {
            id: string;
            description: string;
            isDynamic: boolean;
            prompts: {
                text: string;
            }[];
            agentType?: string | undefined;
            workflows?: string[] | undefined;
            command?: {
                code: string;
                prompted?: boolean | undefined;
            } | undefined;
            transitions?: {
                pass: {
                    kind: "pass" | "fail" | "yes" | "no";
                    action: {
                        type: "CONTINUE";
                    } | {
                        type: "COMPLETE";
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: number | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: number | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: number | "{N}" | "NEXT";
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
                    } | {
                        type: "STOP";
                        message?: string | undefined;
                    } | {
                        type: "GOTO";
                        target: {
                            step: number | "{N}" | "NEXT";
                            substep?: string | undefined;
                        };
                    } | {
                        type: "RETRY";
                        max: number;
                        then: {
                            type: "CONTINUE";
                        } | {
                            type: "COMPLETE";
                        } | {
                            type: "STOP";
                            message?: string | undefined;
                        } | {
                            type: "GOTO";
                            target: {
                                step: number | "{N}" | "NEXT";
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