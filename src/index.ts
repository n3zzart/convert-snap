import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { registerSnapHandler } from "@farcaster/snap-hono";

const app = new Hono();

// ── Helpers ─────────────────────────

function getBaseUrl(req: Request): string {
  const env = process.env.SNAP_PUBLIC_BASE_URL?.trim();
  if (env) return env.replace(/\/$/, "");

  const host = req.headers.get("host") ?? "localhost:3003";
  return host.includes("localhost")
    ? `http://${host}`
    : `https://${host}`;
}

function fmt(n: number) {
  if (!n) return "0";
  if (n >= 1000) return n.toLocaleString("en-US");
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(6);
}

const clean = (v?: string) => v?.trim().toLowerCase();

// ── Cache (fixes rate limit issues) ─────────────────

const priceCache = new Map<string, { price: number; ts: number }>();
const searchCache = new Map<string, string | null>();
const CACHE_TTL = 30_000;

// ── Token Map ─────────────────────────

const DIRECT_MAP: Record<string, string> = {
  btc: "bitcoin",
  eth: "ethereum",
  sol: "solana",
};

// ── API ─────────────────────────

async function fetchPrice(id: string) {
  const cached = priceCache.get(id);
  const now = Date.now();

  if (cached && now - cached.ts < CACHE_TTL) {
    return cached.price;
  }

  const res = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`
  );

  const json = await res.json();
  const price = json[id]?.usd ?? 0;

  priceCache.set(id, { price, ts: now });

  return price;
}

async function searchToken(symbol: string) {
  if (searchCache.has(symbol)) return searchCache.get(symbol)!;

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/search?query=${symbol}`
    );
    const json = await res.json();

    const id = json.coins?.[0]?.id ?? null;
    searchCache.set(symbol, id);

    return id;
  } catch {
    return null;
  }
}

async function resolveToken(sym: string) {
  if (sym === "usd") return { id: "usd", price: 1 };

  if (DIRECT_MAP[sym]) {
    const price = await fetchPrice(DIRECT_MAP[sym]);
    return { id: DIRECT_MAP[sym], price };
  }

  const id = await searchToken(sym);
  if (!id) return { id: null, price: 0 };

  const price = await fetchPrice(id);
  return { id, price };
}

// ── UI ─────────────────────────

function buildUI(
  base: string,
  from: string,
  to: string,
  amount: string,
  result: string,
  note: string,
  shareText: string
) {
  return {
    page: {
      type: "stack",
      props: { gap: "md" },
      children: [
        "title",
        "from-input",
        "from-buttons",
        "to-label",
        "to-input",
        "to-buttons",
        "amount",
        "btn",
        "share",
        "result",
        "note",
      ],
    },

    title: {
      type: "text",
      props: { content: "ConverterSnap", weight: "bold" },
    },

    "from-input": {
      type: "input",
      props: {
        name: "from_input",
        placeholder: "Type any ticker or select from below",
      },
    },

    "from-buttons": {
      type: "toggle_group",
      props: {
        name: "from_toggle",
        options: ["USD", "BTC", "ETH", "SOL"],
      },
    },

    "to-label": {
      type: "text",
      props: { content: "To", weight: "bold" },
    },

    "to-input": {
      type: "input",
      props: {
        name: "to_input",
        placeholder: "Type any ticker or select from below",
      },
    },

    "to-buttons": {
      type: "toggle_group",
      props: {
        name: "to_toggle",
        options: ["USD", "BTC", "ETH", "SOL"],
      },
    },

    amount: {
      type: "input",
      props: {
        name: "amount",
        type: "number",
        placeholder: "Amount to convert",
        defaultValue: amount,
      },
    },

    btn: {
      type: "button",
      props: { label: "Convert", variant: "primary" },
      on: {
        press: {
          action: "submit",
          params: { target: base },
        },
      },
    },

    share: {
      type: "button",
      props: { label: "Share", variant: "secondary" },
      on: {
        press: {
          action: "compose_cast",
          params: {
            text: shareText,
            embeds: [base],
          },
        },
      },
    },

    result: {
      type: "item",
      props: {
        title: "Result",
        description: result,
      },
    },

    note: {
      type: "text",
      props: {
        content: note,
        size: "sm",
        align: "center",
      },
    },
  };
}

// ── Handler ─────────────────────────

registerSnapHandler(app, async (ctx) => {
  try {
    const base = getBaseUrl(ctx.request);

    let from = "usd";
    let to = "btc";
    let amount = "1";

    if (ctx.action?.type === "post") {
      const inputs = (ctx.action as any).inputs ?? {};

      const fromInput = clean(inputs["from_input"]);
      const fromToggle = clean(inputs["from_toggle"]);
      const toInput = clean(inputs["to_input"]);
      const toToggle = clean(inputs["to_toggle"]);

      from = fromInput || fromToggle || from;
      to = toInput || toToggle || to;
      amount = inputs["amount"] || "1";
    }

    let result = "Loading...";
    let note = "";
    let shareText = "Try converting currencies with this snap!";

    try {
      const fromData = await resolveToken(from);
      const toData = await resolveToken(to);

      if (!fromData.price || !toData.price) {
        result = "Invalid token";
      } else {
        const usdVal = parseFloat(amount) * fromData.price;
        const out = usdVal / toData.price;

        result = `${out.toFixed(6)} ${to.toUpperCase()}`;
      }

      note = `${from.toUpperCase()} $${fmt(fromData.price)} · ${to.toUpperCase()} $${fmt(toData.price)}`;

      // ── Share text (polished) ─────────────────

      if (!result.includes("Invalid")) {
        shareText = `Just found out that ${amount} ${from.toUpperCase()} is now ${result}. Convert any currency with the snap below 👇`;
      }
    } catch {
      result = "Error fetching prices";
    }

    return {
      version: "1.0",
      theme: { accent: "purple" },
      ui: {
        root: "page",
        elements: buildUI(base, from, to, amount, result, note, shareText),
      },
    };
  } catch (err) {
    console.error(err);

    return {
      version: "1.0",
      ui: {
        root: "page",
        elements: {
          page: {
            type: "stack",
            props: {},
            children: ["err"],
          },
          err: {
            type: "text",
            props: { content: "Error", weight: "bold" },
          },
        },
      },
    };
  }
});

// ── Server ─────────────────────────

const port = parseInt(process.env.PORT ?? "3003");

serve({ fetch: app.fetch, port }, () => {
  console.log(`Running on http://localhost:${port}`);
});