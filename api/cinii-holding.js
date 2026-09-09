// 旧PWAがこのURLを呼ぶことがあるため、新しい公式OPAC判定へ接続する。
import handler from "./zokei-holding.js";

export const config = { runtime: "edge" };
export default handler;
