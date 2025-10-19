import {
  Address,
  BASE_FEE,
  Contract,
  nativeToScVal,
  Networks,
  rpc,
  scValToNative,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import {
  isConnected,
  requestAccess,
  getAddress,
  getNetworkDetails,
  signTransaction,
} from "@stellar/freighter-api";

// ====== Soroban / Contract config ======
export const RPC_URL = (import.meta.env.VITE_SOROBAN_RPC_URL as string) || "";
export const NETWORK_PASSPHRASE =
  (import.meta.env.VITE_NETWORK_PASSPHRASE as string) || Networks.TESTNET;
export const CONTRACT_ID = (import.meta.env.VITE_CONTRACT_ID as string) || "";
if (!RPC_URL) throw new Error("Thiếu VITE_SOROBAN_RPC_URL trong .env");
if (!CONTRACT_ID) throw new Error("Thiếu VITE_CONTRACT_ID trong .env");

const server = new rpc.Server(RPC_URL, { allowHttp: RPC_URL.startsWith("http://") });
const contract = new Contract(CONTRACT_ID);

// ====== NFT cấu hình 9×9×32 ======
export const NFT_SIZE = 9;
export const NFT_PIXELS = NFT_SIZE * NFT_SIZE; // 81
export const NFT_COLORS = 32;

/** Bắt buộc mảng pixel đúng 81 phần tử, giá trị 0..31 */
function assertPixels9x9(pixels: Uint8Array) {
  if (pixels.length !== NFT_PIXELS) throw new Error("PIXELS_LEN_81");
  for (let i = 0; i < pixels.length; i++) {
    const v = pixels[i];
    if (!Number.isFinite(v) || v < 0 || v >= NFT_COLORS) throw new Error("PIXEL_OUT_OF_RANGE");
  }
}

/** Parse linh hoạt: HEX162 | CSV81 | lưới 9×9 (tab/space/',' + newline) | number[] | Uint8Array
 *  TỰ ĐỘNG CHUẨN HOÁ: nếu dữ liệu là 1..32 (1-based) thì trừ 1 về 0..31.
 */
export function parsePixelsFlex9x9(
  input: string | number[] | Uint8Array
): Uint8Array {
  // Uint8Array
  if (input instanceof Uint8Array) {
    assertPixels9x9(input);
    return input;
  }

  // number[]
  if (Array.isArray(input)) {
    if (input.length !== NFT_PIXELS) throw new Error(`Cần đúng ${NFT_PIXELS} giá trị (9×9).`);
    const min = Math.min(...input);
    const max = Math.max(...input);

    // Nếu dữ liệu 1-based (1..32) => chuyển về 0..31
    const oneBased = min >= 1 && max <= 32;
    const out = new Uint8Array(NFT_PIXELS);
    for (let i = 0; i < NFT_PIXELS; i++) {
      let v = Number(input[i]);
      if (!Number.isInteger(v)) throw new Error(`Giá trị không hợp lệ tại ${i}: ${input[i]}`);
      if (oneBased) v = v - 1; // normalize
      if (v < 0 || v >= NFT_COLORS) throw new Error(`PIXEL_OUT_OF_RANGE tại ${i}: ${v}`);
      out[i] = v;
    }
    return out;
  }

  // string
  const s = input.trim();

  // HEX162 (81 byte, 0..31)
  if (/^[0-9a-fA-F]{162}$/.test(s)) {
    const out = new Uint8Array(NFT_PIXELS);
    for (let i = 0; i < NFT_PIXELS; i++) {
      const val = parseInt(s.slice(i * 2, i * 2 + 2), 16);
      if (!Number.isFinite(val)) throw new Error(`HEX pixel lỗi tại ${i}`);
      if (val < 0 || val >= NFT_COLORS) throw new Error(`HEX out of range tại ${i}: ${val}`);
      out[i] = val;
    }
    return out;
  }

  // Lưới 9×9 / CSV: chấp nhận tab, space, dấu phẩy, xuống dòng
  const rows = s
    .split(/\r?\n/)
    .map((r) => r.replace(/[,\t]+/g, " ").trim())
    .filter((r) => r.length > 0);

  const nums: number[] = [];
  for (const r of rows) {
    const parts = r.split(/\s+/).filter(Boolean);
    for (const p of parts) {
      const v = Number(p);
      if (!Number.isInteger(v)) throw new Error(`Giá trị không hợp lệ: ${p}`);
      nums.push(v);
    }
  }
  if (nums.length !== NFT_PIXELS) {
    throw new Error(`Cần đúng ${NFT_PIXELS} giá trị (9×9). Hiện có ${nums.length}.`);
  }

  // Auto-detect 1-based?
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const oneBased = min >= 1 && max <= 32;

  const out = new Uint8Array(NFT_PIXELS);
  for (let i = 0; i < NFT_PIXELS; i++) {
    let v = nums[i]!;
    if (oneBased) v = v - 1; // normalize 1..32 -> 0..31
    if (v < 0 || v >= NFT_COLORS) throw new Error(`PIXEL_OUT_OF_RANGE tại ${i}: ${v}`);
    out[i] = v;
  }
  return out;
}

// ---------- wallet ----------
export async function connectWallet(): Promise<string> {
  const ok = await isConnected();
  if (!ok || !(ok as any).isConnected) throw new Error("Chưa cài/khởi động Freighter.");

  const a = await getAddress();
  if (a.address) return a.address;

  const acc = await requestAccess();
  if ((acc as any).error) throw new Error("User từ chối Freighter.");
  return (acc as any).address;
}

export async function assertNetwork() {
  const det = await getNetworkDetails();
  if ((det as any).error) return;
  if (det.networkPassphrase !== NETWORK_PASSPHRASE) {
    throw new Error(`Freighter đang ở ${det.network}. Hãy chuyển mạng cho khớp passphrase app.`);
  }
}

// ---------- low-level ----------
async function simulateCall(source: string, method: string, params: any[] = []) {
  const sourceAccount = await server.getAccount(source);
  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...params))
    .setTimeout(30)
    .build();

  const prepared = await server.prepareTransaction(tx);
  const sim = await server.simulateTransaction(prepared);
  if (!rpc.Api.isSimulationSuccess(sim)) throw new Error("Simulation failed");
  const res = sim.result?.retval;
  return res ? scValToNative(res) : null;
}

async function invokeWrite(source: string, method: string, params: any[] = []) {
  const sourceAccount = await server.getAccount(source);
  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...params))
    .setTimeout(120)
    .build();

  const prepared = await server.prepareTransaction(tx);
  const signedRes = await signTransaction(prepared.toXDR(), {
    networkPassphrase: NETWORK_PASSPHRASE,
    address: source,
  });
  if ((signedRes as any).error) throw new Error("Freighter ký thất bại");

  const signedTx = TransactionBuilder.fromXDR(
    (signedRes as any).signedTxXdr,
    NETWORK_PASSPHRASE
  );

  const sent = await server.sendTransaction(signedTx);
  if (sent.status === "PENDING") {
    // đợi đến final (poll nhanh 3 lần)
    for (let i = 0; i < 3; i++) {
      const res = await server.getTransaction(sent.hash);
      if (res.status === "SUCCESS" || res.status === "FAILED") {
        return { hash: sent.hash, status: res.status };
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
    return { hash: sent.hash, status: "PENDING" as const };
  }
  return sent;
}

// ======================================
// =========== Token (FT) ===============
// ======================================
export const readName        = (src: string) => simulateCall(src, "name");
export const readSymbol      = (src: string) => simulateCall(src, "symbol");
export const readDecimals    = (src: string) => simulateCall(src, "decimals");
export const readTotalSupply = (src: string) => simulateCall(src, "total_supply");
export const readBalanceOf   = (src: string, of: string) =>
  simulateCall(src, "balance_of", [Address.fromString(of).toScVal()]);

export const tokenTransfer = (src: string, from: string, to: string, amount: bigint) =>
  invokeWrite(src, "transfer", [
    Address.fromString(from).toScVal(),
    Address.fromString(to).toScVal(),
    nativeToScVal(amount, { type: "i128" }),
  ]);

// ======================================
// =============== NFT ==================
// ======================================

// ---- Reads ----
export const readPalette      = (src: string) => simulateCall(src, "palette_get");
export const readNftValue     = (src: string, id: number) =>
  simulateCall(src, "nft_value", [nativeToScVal(id, { type: "u32" })]);
export const readNftOwnerAndPixels = (src: string, id: number) =>
  simulateCall(src, "nft_get", [nativeToScVal(id, { type: "u32" })]); // (owner, pixels)
export const readNftIdsOf     = (src: string, owner: string) =>
  simulateCall(src, "nft_ids_of", [Address.fromString(owner).toScVal()]);
export const readNftTotal     = (src: string) => simulateCall(src, "nft_total");
export const findNftByValue   = (src: string, pixels: Uint8Array) => {
  assertPixels9x9(pixels);
  return simulateCall(src, "nft_find_by_value", [nativeToScVal(pixels, { type: "bytes" })]);
};
export const searchByPosColor = (src: string, pos: number, color: number) => {
  if (pos < 0 || pos >= NFT_PIXELS) throw new Error("POS_RANGE_0_80");
  if (color < 0 || color >= NFT_COLORS) throw new Error("COLOR_RANGE_0_31");
  return simulateCall(src, "nft_search_pos_color", [
    nativeToScVal(pos, { type: "u32" }),
    nativeToScVal(color, { type: "u32" }),
  ]);
};

// ---- Writes ----
export const nftTransfer = (src: string, from: string, to: string, id: number) =>
  invokeWrite(src, "nft_transfer", [
    Address.fromString(from).toScVal(),
    Address.fromString(to).toScVal(),
    nativeToScVal(id, { type: "u32" }),
  ]);

/** Mint 9×9: pixels phải là Uint8Array dài 81, mỗi phần tử 0..31 */
export const mintNft = (src: string, to: string, pixels: Uint8Array) => {
  assertPixels9x9(pixels);
  return invokeWrite(src, "mint_nft", [
    Address.fromString(to).toScVal(),
    nativeToScVal(pixels, { type: "bytes" }),
  ]);
};

/** Mint linh hoạt từ chuỗi/grid/hex/array */
export const mintNftFlex = (
  src: string,
  to: string,
  pixelsInput: string | number[] | Uint8Array
) => {
  const pixels = parsePixelsFlex9x9(pixelsInput);
  return mintNft(src, to, pixels);
};

/** Đánh chỉ mục theo lô cho id trong [start, end), ví dụ 0..27, 27..54, 54..81 */
export const nftIndexRange = (src: string, id: number, start: number, end: number) => {
  if (start < 0 || end < 0 || start >= end) throw new Error("BAD_RANGE");
  if (end > NFT_PIXELS) throw new Error("BAD_RANGE");
  return invokeWrite(src, "nft_index_range", [
    nativeToScVal(id, { type: "u32" }),
    nativeToScVal(start, { type: "u32" }),
    nativeToScVal(end, { type: "u32" }),
  ]);
};

// Palette (Vec<u32>)
function toVecU32ScVal(arr: number[]) {
  const items = arr.map((n) => nativeToScVal((n >>> 0), { type: "u32" }));
  return nativeToScVal(items, { type: "vec" });
}
export const paletteSet = (src: string, newPalette: number[]) => {
  if (!Array.isArray(newPalette) || newPalette.length !== 32)
    throw new Error("PALETTE_32_REQUIRED");
  return invokeWrite(src, "palette_set", [toVecU32ScVal(newPalette)]);
};

// ======================================
// =========== Marketplace ==============
// ======================================
export const listingFeeGet = (src: string) => simulateCall(src, "listing_fee_get");
export const listingFeeSet = (src: string, fee: bigint) =>
  invokeWrite(src, "listing_fee_set", [nativeToScVal(fee, { type: "i128" })]);

export const marketList = (src: string, seller: string, id: number, price: bigint) =>
  invokeWrite(src, "market_list_nft", [
    Address.fromString(seller).toScVal(),
    nativeToScVal(id, { type: "u32" }),
    nativeToScVal(price, { type: "i128" }),
  ]);

export const marketCancel = (src: string, seller: string, id: number) =>
  invokeWrite(src, "market_cancel", [
    Address.fromString(seller).toScVal(),
    nativeToScVal(id, { type: "u32" }),
  ]);

export const marketBuy = (src: string, buyer: string, id: number) =>
  invokeWrite(src, "market_buy", [
    Address.fromString(buyer).toScVal(),
    nativeToScVal(id, { type: "u32" }),
  ]);

export const marketGet = (src: string, id: number) =>
  simulateCall(src, "market_get", [nativeToScVal(id, { type: "u32" })]); // Option<(seller, price)>
export const marketListIds = (src: string) => simulateCall(src, "market_list_ids");

// ======================================
// =========== Tiện ích UI ==============
// ======================================

/** Tạo Uint8Array 81 phần tử từ mảng số (tự cắt/pad 0) */
export function toPixels9x9(arr: number[]): Uint8Array {
  const out = new Uint8Array(NFT_PIXELS);
  for (let i = 0; i < NFT_PIXELS; i++) out[i] = (arr[i] ?? 0) & 0xff;
  assertPixels9x9(out);
  return out;
}

/** Chia lô 27 phần tử để index (3 lần: 0..27, 27..54, 54..81) */
export async function indexAllBatches(src: string, id: number, batch = 27) {
  let start = 0;
  while (start < NFT_PIXELS) {
    const end = Math.min(start + batch, NFT_PIXELS);
    await nftIndexRange(src, id, start, end);
    start = end;
  }
}
