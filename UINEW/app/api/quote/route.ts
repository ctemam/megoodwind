import { NextRequest, NextResponse } from "next/server";

const ONEINCH_API_KEY = process.env.NEXT_PUBLIC_1INCH_API_KEY;
const ONEINCH_API_BASE = "https://api.1inch.dev/swap/v6.0/1";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const src = searchParams.get("src"); // Source token
    const dst = searchParams.get("dst"); // Destination token
    const amount = searchParams.get("amount"); // Amount in wei

    if (!src || !dst || !amount) {
      return NextResponse.json(
        { error: "Missing required parameters: src, dst, amount" },
        { status: 400 }
      );
    }

    if (!ONEINCH_API_KEY) {
      return NextResponse.json(
        { error: "1inch API key not configured" },
        { status: 500 }
      );
    }

    // Call 1inch API to get quote
    const quoteUrl = `${ONEINCH_API_BASE}/quote?src=${src}&dst=${dst}&amount=${amount}`;

    const response = await fetch(quoteUrl, {
      headers: {
        Authorization: `Bearer ${ONEINCH_API_KEY}`,
        accept: "application/json",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("1inch API error:", errorText);
      return NextResponse.json(
        { error: "Failed to fetch quote from 1inch", details: errorText },
        { status: response.status }
      );
    }

    const data = await response.json();

    // Return formatted quote data
    return NextResponse.json({
      srcToken: data.srcToken,
      dstToken: data.dstToken,
      srcAmount: data.srcAmount,
      dstAmount: data.dstAmount,
      protocols: data.protocols,
      estimatedGas: data.estimatedGas,
    });
  } catch (error) {
    console.error("Quote API error:", error);
    return NextResponse.json(
      { error: "Internal server error", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
