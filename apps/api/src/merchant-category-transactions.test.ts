import { expect, it, vi } from "vitest";
import { CatalogError, CatalogProductListError, CatalogOptionSetListError } from "@rms/catalog";
import {
  createMerchantCategoryTransactions,
  registerMerchantTransactionBeforeCommit,
} from "./merchant-category-transactions.js";
import { MerchantProductWriteFeatureDisabled } from "./merchant-product-write-authority.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { OptionPriceAuthoringError, TaxConfigWorkflowError } from "@rms/pricing";
import {
  StoreSetupOperationError,
  StoreSetupReferenceError,
  StoreConfigurationOriginalError,
  StoreConfigurationAdministrationServiceError,
} from "@rms/store";
import { StorePaymentConfigurationError } from "@rms/payment";
import { DigitalReceiptTemplateError } from "@rms/printing-device";
import { BrandConfigurationOperationError } from "@bop/tenant";
type Transaction = Parameters<
  Parameters<ReturnType<typeof createMerchantCategoryTransactions>["transactions"]["run"]>[0]
>[0];
function fixture() {
  const events: string[] = [];
  const query = vi.fn(async (): Promise<unknown> => ({
    rows: [],
    rowCount: 0,
  }));
  const source: PersistentMerchantBffOptions["transactions"] = {
    async run(work) {
      events.push("BEGIN");
      try {
        const result = await work({ query });
        events.push("COMMIT");
        return result;
      } catch (error) {
        events.push("ROLLBACK");
        throw error;
      }
    },
  };
  return { ...createMerchantCategoryTransactions(source), events, query };
}
it.each(["work", "check", "final"] as const)(
  "preserves actual Brand configuration refusal during %s and rolls back",
  async (stage) => {
    const f = fixture();
    const refusal = new BrandConfigurationOperationError("BRAND_CONFIGURATION_PERMISSION_DENIED");
    await expect(
      f.transactions.run(async (tx) => {
        if (stage === "work") throw refusal;
        await f.registerBeforeCommit(
          tx,
          async () => {
            if (stage === "check") throw refusal;
          },
          () => {
            if (stage === "final") throw refusal;
          },
        );
      }),
    ).rejects.toBe(refusal);
    expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
    expect(f.query).not.toHaveBeenCalled();
  },
);
it.each(["work", "check", "final"] as const)(
  "preserves actual Store Setup refusal during %s and rolls back",
  async (stage) => {
    const f = fixture();
    const refusal = new StoreSetupOperationError("STORE_SETUP_OPERATION_VERSION_CONFLICT");
    await expect(
      f.transactions.run(async (tx) => {
        if (stage === "work") throw refusal;
        await f.registerBeforeCommit(
          tx,
          async () => {
            if (stage === "check") throw refusal;
          },
          () => {
            if (stage === "final") throw refusal;
          },
        );
      }),
    ).rejects.toBe(refusal);
    expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
    expect(f.query).not.toHaveBeenCalled();
  },
);
it.each(["work", "check", "final"] as const)(
  "preserves actual Store Setup Reference refusal during %s and rolls back",
  async (stage) => {
    const f = fixture();
    const refusal = new StoreSetupReferenceError("STORE_SETUP_REFERENCE_VERSION_CONFLICT");
    await expect(
      f.transactions.run(async (tx) => {
        if (stage === "work") throw refusal;
        await f.registerBeforeCommit(
          tx,
          async () => {
            if (stage === "check") throw refusal;
          },
          () => {
            if (stage === "final") throw refusal;
          },
        );
      }),
    ).rejects.toBe(refusal);
    expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
    expect(f.query).not.toHaveBeenCalled();
  },
);
it.each(["work", "check", "final"] as const)(
  "preserves actual Store Payment Configuration refusal during %s and rolls back",
  async (stage) => {
    const f = fixture();
    const refusal = new StorePaymentConfigurationError(
      "STORE_PAYMENT_CONFIGURATION_VERSION_CONFLICT",
    );
    await expect(
      f.transactions.run(async (tx) => {
        if (stage === "work") throw refusal;
        await f.registerBeforeCommit(
          tx,
          async () => {
            if (stage === "check") throw refusal;
          },
          () => {
            if (stage === "final") throw refusal;
          },
        );
      }),
    ).rejects.toBe(refusal);
    expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
    expect(f.query).not.toHaveBeenCalled();
  },
);
it.each(["work", "check", "final"] as const)(
  "preserves actual Digital Receipt Template refusal during %s and rolls back",
  async (stage) => {
    const f = fixture();
    const refusal = new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_CONFLICT");
    await expect(
      f.transactions.run(async (tx) => {
        if (stage === "work") throw refusal;
        await f.registerBeforeCommit(
          tx,
          async () => {
            if (stage === "check") throw refusal;
          },
          () => {
            if (stage === "final") throw refusal;
          },
        );
      }),
    ).rejects.toBe(refusal);
    expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
    expect(f.query).not.toHaveBeenCalled();
  },
);
it.each(["work", "check", "final"] as const)(
  "preserves actual Pricing refusal during %s and rolls back",
  async (stage) => {
    const f = fixture();
    const refusal = new OptionPriceAuthoringError("OPTION_PRICE_VERSION_CONFLICT");
    await expect(
      f.transactions.run(async (tx) => {
        if (stage === "work") throw refusal;
        await f.registerBeforeCommit(
          tx,
          async () => {
            if (stage === "check") throw refusal;
          },
          () => {
            if (stage === "final") throw refusal;
          },
        );
      }),
    ).rejects.toBe(refusal);
    expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
    expect(f.query).not.toHaveBeenCalled();
  },
);
it.each(["work", "check", "final"] as const)(
  "preserves actual Tax Configuration refusal during %s and rolls back",
  async (stage) => {
    const f = fixture();
    const refusal = new TaxConfigWorkflowError("TAX_CONFIG_VERSION_CONFLICT");
    await expect(
      f.transactions.run(async (tx) => {
        if (stage === "work") throw refusal;
        await f.registerBeforeCommit(
          tx,
          async () => {
            if (stage === "check") throw refusal;
          },
          () => {
            if (stage === "final") throw refusal;
          },
        );
      }),
    ).rejects.toBe(refusal);
    expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
    expect(f.query).not.toHaveBeenCalled();
  },
);
it.each(["work", "check"])(
  "preserves disabled Product capability during %s with rollback",
  async (stage) => {
    const f = fixture();
    const refusal = new MerchantProductWriteFeatureDisabled();
    await expect(
      f.transactions.run(async (tx) => {
        if (stage === "work") throw refusal;
        await f.registerBeforeCommit(tx, async () => {
          throw refusal;
        });
      }),
    ).rejects.toBe(refusal);
    expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
    expect(f.query).not.toHaveBeenCalled();
  },
);
it("runs registered checks inside the runner action before COMMIT and preserves result", async () => {
  const f = fixture();
  const result = await f.transactions.run(async (tx) => {
    await f.registerBeforeCommit(tx, async () => {
      f.events.push("CHECK_A");
      await tx.query("synthetic check", []);
    });
    await f.registerBeforeCommit(tx, async () => {
      f.events.push("CHECK_B");
    });
    f.events.push("WORK");
    return "RESULT";
  });
  expect(result).toBe("RESULT");
  expect(f.events).toEqual(["BEGIN", "WORK", "CHECK_A", "CHECK_B", "COMMIT"]);
});
it("runs every synchronous lease assertion after all awaited guards", async () => {
  const f = fixture();
  const result = await f.transactions.run(async (tx) => {
    for (const name of ["A", "B"]) {
      await f.registerBeforeCommit(
        tx,
        async () => {
          await tx.query("synthetic authority " + name, []);
          f.events.push("CHECK_" + name);
        },
        () => {
          f.events.push("FINAL_" + name);
        },
      );
    }
    return "RESULT";
  });
  expect(result).toBe("RESULT");
  expect(f.events).toEqual(["BEGIN", "CHECK_A", "CHECK_B", "FINAL_A", "FINAL_B", "COMMIT"]);
});
it("rolls back when a later awaited guard expires an earlier original lease", async () => {
  const f = fixture();
  let time = 0;
  const lease = () => {
    if (time >= 1000) throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  };
  await expect(
    f.transactions.run(async (tx) => {
      await f.registerBeforeCommit(
        tx,
        async () => {
          lease();
          f.events.push("EARLIER_ALLOWED");
        },
        lease,
      );
      await f.registerBeforeCommit(tx, async () => {
        await tx.query("synthetic later authority", []);
        time = 1000;
      });
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.events).toEqual(["BEGIN", "EARLIER_ALLOWED", "ROLLBACK"]);
});
it.each(["value", "promise", "rejected-promise"])(
  "refuses a nonvoid final assertion without awaiting it: %s",
  async (mode) => {
    const f = fixture();
    await expect(
      f.transactions.run(async (tx) => {
        await f.registerBeforeCommit(
          tx,
          async () => undefined,
          () => {
            if (mode === "promise") return Promise.resolve();
            if (mode === "rejected-promise")
              return Promise.reject(new Error("synthetic async final"));
            return true;
          },
        );
      }),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
  },
);
it.each(["registration", "query"])(
  "poisons a caught %s attempt during the synchronous final phase",
  async (mode) => {
    const f = fixture();
    let refusal: Promise<unknown> | undefined;
    await expect(
      f.transactions.run(async (tx) => {
        await f.registerBeforeCommit(
          tx,
          async () => undefined,
          () => {
            refusal = (
              mode === "registration"
                ? f.registerBeforeCommit(tx, async () => undefined)
                : tx.query("forbidden final query", [])
            ).catch((error: unknown) => error);
          },
        );
      }),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(await refusal).toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(f.query).not.toHaveBeenCalled();
    expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
  },
);
it("cannot replace or remove a registered final assertion by catching a duplicate registration", async () => {
  const f = fixture(),
    check = async () => undefined,
    final = () => undefined;
  await expect(
    f.transactions.run(async (tx) => {
      await f.registerBeforeCommit(tx, check, final);
      await f.registerBeforeCommit(tx, check, final);
      await f.registerBeforeCommit(tx, check).catch(() => undefined);
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
});
it("missing COMMIT check registration forces rollback", async () => {
  const f = fixture();
  await expect(
    f.transactions.run(async (tx) => {
      await tx.query("synthetic write", []);
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
});
it.each([true, false])(
  "check failure forces rollback with bounded error, Catalog=%s",
  async (catalog) => {
    const f = fixture();
    await expect(
      f.transactions.run(async (tx) => {
        await f.registerBeforeCommit(tx, async () => {
          throw catalog
            ? new CatalogError("CATALOG_PERMISSION_DENIED")
            : new Error("SYNTHETIC_PRIVATE_DRIVER_DETAIL");
        });
      }),
    ).rejects.toMatchObject({
      code: catalog ? "CATALOG_PERMISSION_DENIED" : "CATALOG_DEPENDENCY_UNAVAILABLE",
      message: "catalog is unavailable",
    });
    expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
  },
);
it("caught query failure still forces rollback", async () => {
  const f = fixture();
  f.query.mockRejectedValue(new Error("SYNTHETIC_PRIVATE_DRIVER_DETAIL"));
  await expect(
    f.transactions.run(async (tx) => {
      await f.registerBeforeCommit(tx, async () => undefined);
      await tx.query("synthetic failed query", []).catch(() => undefined);
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
});
it.each(["work", "checks"])("unawaited query during %s prevents COMMIT", async (stage) => {
  const f = fixture();
  let finish!: (value: unknown) => void;
  f.query.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  let pending!: Promise<unknown>;
  await expect(
    f.transactions.run(async (tx) => {
      await f.registerBeforeCommit(tx, async () => {
        if (stage === "checks")
          pending = tx.query("synthetic pending", []).catch((error: unknown) => error);
      });
      if (stage === "work")
        pending = tx.query("synthetic pending", []).catch((error: unknown) => error);
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
  finish({ rows: [], rowCount: 0 });
  expect(await pending).toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("reentrant registration during checks taints transaction even if caught", async () => {
  const f = fixture();
  await expect(
    f.transactions.run(async (tx) => {
      await f.registerBeforeCommit(tx, async () => {
        await f.registerBeforeCommit(tx, async () => undefined).catch(() => undefined);
      });
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
});
it("borrowed transaction cannot query or register after completion", async () => {
  const f = fixture();
  let captured!: Transaction;
  await f.transactions.run(async (tx) => {
    captured = tx;
    await f.registerBeforeCommit(tx, async () => undefined);
  });
  await expect(captured.query("late synthetic query", [])).rejects.toThrow();
  await expect(f.registerBeforeCommit(captured, async () => undefined)).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
});
it("foreign host transaction cannot register checks", async () => {
  const f = fixture(),
    other = fixture();
  await expect(
    f.transactions.run(async (tx) => {
      await other.registerBeforeCommit(tx, async () => undefined);
    }),
  ).rejects.toThrow();
  expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
});
it.each([
  { rows: null },
  { rows: [], rowCount: -1 },
  {
    rows: [],
    get rowCount() {
      throw new Error("SYNTHETIC_ACCESSOR");
    },
  },
])("malformed result fails bounded without accessor execution %#", async (result) => {
  const f = fixture();
  f.query.mockResolvedValue(result);
  await expect(
    f.transactions.run(async (tx) => {
      await f.registerBeforeCommit(tx, async () => undefined);
      await tx.query("synthetic malformed", []);
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
});
it("retains and executes all guards for a complete bounded publication graph", async () => {
  const f = fixture();
  const calls: number[] = [];
  await f.transactions.run(async (tx) => {
    for (let i = 0; i < 128; i++) {
      await f.registerBeforeCommit(tx, async () => {
        calls.push(i);
      });
    }
  });
  expect(calls).toEqual(Array.from({ length: 128 }, (_, i) => i));
  expect(f.events).toEqual(["BEGIN", "COMMIT"]);
});
it("finite registration budget cannot be bypassed by catching rejection", async () => {
  const f = fixture();
  await expect(
    f.transactions.run(async (tx) => {
      for (let i = 0; i < 128; i++) await f.registerBeforeCommit(tx, async () => undefined);
      await f.registerBeforeCommit(tx, async () => undefined).catch(() => undefined);
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
});
it("underlying transaction outcome failure remains unavailable", async () => {
  const host = createMerchantCategoryTransactions({
    run: async () => {
      throw new Error("SYNTHETIC_COMMIT_OUTCOME_UNKNOWN");
    },
  });
  await expect(host.transactions.run(async () => undefined)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    message: "catalog is unavailable",
  });
});

for (const stage of ["work", "check"] as const) {
  it.each(["Invalid", "Denied", "FeatureDisabled", "DependencyUnavailable", "Stale"] as const)(
    `preserves bounded Option List %s outcome from ${stage} with rollback`,
    async (code) => {
      const f = fixture();
      const error = new CatalogOptionSetListError(code);
      await expect(
        f.transactions.run(async (tx) => {
          await f.registerBeforeCommit(tx, async () => {
            if (stage === "check") throw error;
          });
          if (stage === "work") throw error;
        }),
      ).rejects.toBe(error);
      expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
    },
  );
  it.each(["Invalid", "Denied", "FeatureDisabled", "Unavailable", "Stale"] as const)(
    `preserves bounded Product List %s outcome from ${stage} with rollback`,
    async (code) => {
      const f = fixture();
      const error = new CatalogProductListError(code);
      await expect(
        f.transactions.run(async (tx) => {
          await f.registerBeforeCommit(tx, async () => {
            if (stage === "check") throw error;
          });
          if (stage === "work") throw error;
        }),
      ).rejects.toBe(error);
      expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
    },
  );
}

it.each([
  new StoreConfigurationOriginalError("STORE_CONFIGURATION_ORIGINAL_IDEMPOTENCY_CONFLICT"),
  new StoreConfigurationOriginalError("STORE_CONFIGURATION_ORIGINAL_PERMISSION_DENIED"),
  new StoreConfigurationAdministrationServiceError("STORE_CONFIGURATION_VERSION_CONFLICT"),
])(
  "preserves owning Store configuration failure and rolls back the original transaction: $code",
  async (refusal) => {
    const f = fixture();
    await expect(
      f.transactions.run(async () => {
        throw refusal;
      }),
    ).rejects.toBe(refusal);
    expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
  },
);

it("locates only an exact live wrapper and removes it after host closure", async () => {
  const f = fixture();
  let captured: Transaction | undefined;
  const guard = vi.fn(async () => undefined),
    final = vi.fn(() => undefined);
  await expect(
    registerMerchantTransactionBeforeCommit({ query: f.query }, guard, final),
  ).rejects.toThrow();
  await f.transactions.run(async (tx) => {
    captured = tx;
    await expect(
      registerMerchantTransactionBeforeCommit({ ...tx }, guard, final),
    ).rejects.toThrow();
    await registerMerchantTransactionBeforeCommit(tx, guard, final);
    expect(guard).not.toHaveBeenCalled();
    expect(final).not.toHaveBeenCalled();
  });
  if (!captured) throw new Error("missing controlled host wrapper");
  await expect(registerMerchantTransactionBeforeCommit(captured, guard, final)).rejects.toThrow();
  expect(guard).toHaveBeenCalledTimes(1);
  expect(final).toHaveBeenCalledTimes(1);
  expect(f.events).toEqual(["BEGIN", "COMMIT"]);
});

it("routes both genuine nested handles to the correct registry before one COMMIT", async () => {
  const f = fixture();
  const events: string[] = [];
  const nested = createMerchantCategoryTransactions({
    run: (work) =>
      f.transactions.run(async (outerTx) => {
        await registerMerchantTransactionBeforeCommit(
          outerTx,
          async () => {
            events.push("OUTER_CHECK");
          },
          () => {
            events.push("OUTER_FINAL");
          },
        );
        return work(outerTx);
      }),
  });
  await nested.transactions.run(async (innerTx) => {
    await registerMerchantTransactionBeforeCommit(
      innerTx,
      async () => {
        events.push("INNER_CHECK");
        await innerTx.query("controlled query", []);
      },
      () => {
        events.push("INNER_FINAL");
      },
    );
    await expect(f.registerBeforeCommit(innerTx, async () => undefined)).rejects.toThrow();
  });
  expect(events).toEqual(["INNER_CHECK", "INNER_FINAL", "OUTER_CHECK", "OUTER_FINAL"]);
  expect(f.events).toEqual(["BEGIN", "COMMIT"]);
});

it.each(["bad guard", "bad final", "mismatched duplicate", "over budget"] as const)(
  "locator delegates %s refusal to the owning poison state even when caught",
  async (mode) => {
    const f = fixture(),
      guard = async () => undefined,
      final = () => undefined;
    await expect(
      f.transactions.run(async (tx) => {
        await registerMerchantTransactionBeforeCommit(tx, guard, final);
        if (mode === "bad guard") {
          const invalid = undefined;
          // @ts-expect-error Deliberately invalid public runtime input.
          await registerMerchantTransactionBeforeCommit(tx, invalid, final).catch(() => undefined);
        } else if (mode === "bad final") {
          const invalid = true;
          // @ts-expect-error Deliberately invalid public runtime input.
          await registerMerchantTransactionBeforeCommit(tx, guard, invalid).catch(() => undefined);
        } else if (mode === "mismatched duplicate") {
          await registerMerchantTransactionBeforeCommit(tx, guard).catch(() => undefined);
        } else {
          for (let i = 1; i < 128; i++)
            await registerMerchantTransactionBeforeCommit(tx, async () => undefined);
          await registerMerchantTransactionBeforeCommit(tx, async () => undefined).catch(
            () => undefined,
          );
        }
      }),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
  },
);

it.each(["checks", "final"] as const)(
  "locator late registration during %s poisons caught attempts",
  async (phase) => {
    const f = fixture();
    let attempted: Promise<unknown> | undefined;
    const late = (tx: Transaction) => {
      attempted = registerMerchantTransactionBeforeCommit(tx, async () => undefined).catch(
        (error) => error,
      );
    };
    await expect(
      f.transactions.run(async (tx) => {
        await registerMerchantTransactionBeforeCommit(
          tx,
          async () => {
            if (phase === "checks") {
              late(tx);
              await attempted;
            }
          },
          () => {
            if (phase === "final") late(tx);
          },
        );
      }),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(await attempted).toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
  },
);

it("locator retains duplicate matching and refuses an asynchronous final before COMMIT", async () => {
  const f = fixture(),
    guard = vi.fn(async () => undefined);
  const final = vi.fn(() => Promise.reject(new Error("controlled forbidden async final")));
  await expect(
    f.transactions.run(async (tx) => {
      await f.registerBeforeCommit(tx, guard, final);
      await registerMerchantTransactionBeforeCommit(tx, guard, final);
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(guard).toHaveBeenCalledTimes(1);
  expect(final).toHaveBeenCalledTimes(1);
  expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
});

it("nested locator guard failure rolls back the actual outer transaction and closes both handles", async () => {
  const f = fixture();
  let outer: Transaction | undefined, inner: Transaction | undefined;
  const nested = createMerchantCategoryTransactions({
    run: (work) =>
      f.transactions.run(async (tx) => {
        outer = tx;
        await registerMerchantTransactionBeforeCommit(tx, async () => undefined);
        return work(tx);
      }),
  });
  await expect(
    nested.transactions.run(async (tx) => {
      inner = tx;
      await registerMerchantTransactionBeforeCommit(tx, async () => {
        throw Error("controlled denial");
      });
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  if (!outer || !inner) throw Error("missing controlled nested handles");
  await expect(
    registerMerchantTransactionBeforeCommit(outer, async () => undefined),
  ).rejects.toThrow();
  await expect(
    registerMerchantTransactionBeforeCommit(inner, async () => undefined),
  ).rejects.toThrow();
  expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
});

it("keeps per-instance registration isolated while the locator accepts each real live host", async () => {
  const first = fixture(),
    second = fixture(),
    events: string[] = [];
  await first.transactions.run(async (firstTx) => {
    await registerMerchantTransactionBeforeCommit(firstTx, async () => {
      events.push("FIRST");
    });
    await second.transactions.run(async (secondTx) => {
      await expect(first.registerBeforeCommit(secondTx, async () => undefined)).rejects.toThrow();
      await expect(second.registerBeforeCommit(firstTx, async () => undefined)).rejects.toThrow();
      await registerMerchantTransactionBeforeCommit(secondTx, async () => {
        events.push("SECOND");
      });
    });
  });
  expect(events).toEqual(["SECOND", "FIRST"]);
  expect(first.events).toEqual(["BEGIN", "COMMIT"]);
  expect(second.events).toEqual(["BEGIN", "COMMIT"]);
});
