const TOKYO_ZOKEI_OPAC = "https://lib.kuwasawa.ac.jp/opac/opac_search/";

// 東京造形大学OPACは応答に10秒以上かかる場合がある。
export const config = { maxDuration: 60 };

function buildSearchUrl(isbn) {
  const params = new URLSearchParams({
    lang: "0",
    amode: "2",
    cmode: "0",
    smode: "0",
    kywd: isbn,
    countercd: "100001",
  });
  params.append("dpmc_exp[]", "東京造形大学");
  return `${TOKYO_ZOKEI_OPAC}?${params.toString()}`;
}

export default async function handler(request, response) {
  const isbn = String(request.query?.isbn || "").replace(/\D/g, "");
  if (isbn.length !== 10 && isbn.length !== 13) {
    return response.status(400).json({ status: "unavailable" });
  }

  const searchUrl = buildSearchUrl(isbn);

  try {
    const opacResponse = await fetch(searchUrl, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "MyLibraryApp/1.0 (Tokyo Zokei OPAC holdings check)",
      },
    });
    if (!opacResponse.ok) throw new Error(`OPAC search failed: ${opacResponse.status}`);

    const html = await opacResponse.text();
    const isNotHeld = html.includes("該当する資料が学内に見つかりません");
    const resultCountMatch = html.match(/該当件数\s*:\s*([\d,]+)件/);
    const resultCount = resultCountMatch
      ? Number(resultCountMatch[1].replace(/,/g, ""))
      : null;

    if (!isNotHeld && (!Number.isFinite(resultCount) || resultCount < 1)) {
      throw new Error("OPAC response did not contain a recognizable result");
    }

    response.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");
    return response.status(200).json({
      status: isNotHeld ? "not-held" : "held",
      searchUrl,
    });
  } catch (error) {
    console.error("Tokyo Zokei OPAC lookup failed", error);
    return response.status(502).json({ status: "unavailable", searchUrl });
  }
}
