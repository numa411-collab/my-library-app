const CINII_APP_ID = "Eij6hrIjjV5h5NbAQ2qh";
const TOKYO_ZOKEI_LIBRARY_ID = "FA006055";

function firstNcid(item) {
  const rawIdentifiers = item?.["dc:identifier"];
  const identifiers = Array.isArray(rawIdentifiers)
    ? rawIdentifiers
    : rawIdentifiers
      ? [rawIdentifiers]
      : [];

  const ncid = identifiers.find((identifier) => identifier?.["@type"] === "cir:NCID");
  return String(ncid?.["@value"] || "").trim();
}

export default async function handler(request, response) {
  const isbn = String(request.query?.isbn || "").replace(/\D/g, "");
  if (isbn.length !== 10 && isbn.length !== 13) {
    return response.status(400).json({ status: "unavailable" });
  }

  try {
    const bookParams = new URLSearchParams({
      isbn,
      format: "json",
      count: "1",
      appid: CINII_APP_ID,
    });
    const bookResponse = await fetch(`https://cir.nii.ac.jp/opensearch/books?${bookParams}`);
    if (!bookResponse.ok) throw new Error("CiNii book search failed");

    const bookJson = await bookResponse.json();
    const item = Array.isArray(bookJson?.items) ? bookJson.items[0] : null;
    const ncid = firstNcid(item);
    if (!ncid) return response.status(200).json({ status: "not-held" });

    const holdingParams = new URLSearchParams({
      ncid,
      fano: TOKYO_ZOKEI_LIBRARY_ID,
      format: "json",
      appid: CINII_APP_ID,
    });
    const holdingResponse = await fetch(`https://cir.nii.ac.jp/opensearch/holder?${holdingParams}`);
    if (!holdingResponse.ok) throw new Error("CiNii holding search failed");

    const holdingJson = await holdingResponse.json();
    const graph = Array.isArray(holdingJson?.["@graph"]) ? holdingJson["@graph"] : [];
    const channel = graph.find((entry) => entry?.["@type"] === "channel") || graph[0] || {};
    const total = Number(channel?.["opensearch:totalResults"] ?? 0);

    response.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");
    return response.status(200).json({ status: total > 0 ? "held" : "not-held" });
  } catch (error) {
    console.error("CiNii holding lookup failed", error);
    return response.status(502).json({ status: "unavailable" });
  }
}
