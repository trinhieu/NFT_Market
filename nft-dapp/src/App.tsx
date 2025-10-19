import { useEffect, useMemo, useRef, useState } from "react";
import {
  assertNetwork, connectWallet,
  readName, readSymbol, readDecimals, readTotalSupply, readBalanceOf,
  tokenTransfer,
  readPalette, readNftValue, readNftIdsOf,
  nftTransfer,
  marketListIds, marketGet, marketList, marketCancel, marketBuy,
  mintNftFlex, parsePixelsFlex9x9
} from "./stellar";
import { drawNftToCanvas } from "./nftRender";

/* =========================================================
 * CẤU HÌNH CHUNG
 * =======================================================*/
const NFT_SIZE = 9;
const NFT_PIXELS = NFT_SIZE * NFT_SIZE; // 81
const NFT_COLORS = 32;

const DEFAULT_PALETTE: number[] = [
  0x000000,0x222034,0x45283c,0x663931,0x8f563b,0xdf7126,0xd9a066,0xeec39a,
  0xfbf236,0x99e550,0x6abe30,0x37946e,0x4b692f,0x524b24,0x323c39,0x3f3f74,
  0x306082,0x5b6ee1,0x639bff,0x5fcde4,0xcbdbfc,0xffffff,0x9badb7,0x847e87,
  0x696a6a,0x595652,0x76428a,0xac3232,0xd95763,0xd77bba,0x8f974a,0x8a6f30
];

function usePal(palState: number[] | null): number[] {
  return palState && palState.length === NFT_COLORS ? palState : DEFAULT_PALETTE;
}

/* =========================================================
 * NOTIFICATION CENTER (toast)
 * =======================================================*/
type NoticeType = "info" | "success" | "warn" | "error";
type Notice = { id: string; type: NoticeType; text: string; timeout?: number };

function useNotify() {
  const [items, setItems] = useState<Notice[]>([]);
  const push = (type: NoticeType, text: string, timeout = 3800) => {
    const id = Math.random().toString(36).slice(2);
    const entry: Notice = { id, type, text, timeout };
    setItems((s) => [...s, entry]);
    if (timeout > 0) {
      setTimeout(() => {
        setItems((s) => s.filter((x) => x.id !== id));
      }, timeout);
    }
  };
  return {
    items,
    notify: {
      info: (t: string, ms?: number) => push("info", t, ms),
      ok: (t: string, ms?: number) => push("success", t, ms),
      warn: (t: string, ms?: number) => push("warn", t, ms),
      err: (t: string, ms?: number) => push("error", t, ms),
    },
    remove: (id: string) => setItems((s) => s.filter((x) => x.id !== id)),
  };
}

function NotificationCenter({ items, remove }:{ items:Notice[]; remove:(id:string)=>void }) {
  const pill = (t: NoticeType) => {
    switch (t) {
      case "success": return "#2ecc71";
      case "warn":    return "#f39c12";
      case "error":   return "#e74c3c";
      default:        return "#3498db";
    }
  };
  return (
    <div style={{
      position:"fixed", top:16, right:16, display:"grid", gap:8, zIndex:9999, width:360, maxWidth:"calc(100vw - 32px)"
    }}>
      {items.map(n=>(
        <div key={n.id}
          style={{
            border:"1px solid #333", borderRadius:12, padding:"10px 12px",
            background:"#1d1d1f", boxShadow:"0 10px 30px rgba(0,0,0,.5)", display:"flex", gap:10, alignItems:"start"
          }}>
          <div style={{ width:10, height:10, borderRadius:999, marginTop:5, background:pill(n.type) }}/>
          <div style={{ color:"#eee", fontSize:14, lineHeight:1.35, whiteSpace:"pre-wrap" }}>{n.text}</div>
          <button onClick={()=>remove(n.id)}
            style={{ marginLeft:"auto", background:"transparent", border:"none", color:"#999", cursor:"pointer" }}>✕</button>
        </div>
      ))}
    </div>
  );
}

/* =========================================================
 * KHUNG SECTION
 * =======================================================*/
function Section({
  title, actions, children, id
}:{
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  id?: string;
}) {
  return (
    <section id={id} style={{ border:"1px solid #2b2b2b", borderRadius:14, padding:16, background:"#161616" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
        <h3 style={{ margin:0 }}>{title}</h3>
        <div style={{ display:"flex", gap:8 }}>{actions}</div>
      </div>
      {children}
    </section>
  );
}

/* =========================================================
 * THÀNH PHẦN CON
 * =======================================================*/
function MyNftThumb({ id, pk, palette }:{ id:number; pk:string; palette:number[] | null }) {
  const ref = useRef<HTMLCanvasElement|null>(null);
  useEffect(()=>{ (async()=>{
    try {
      if (!palette) return;
      const px = await readNftValue(pk, id) as Uint8Array;
      if (!px || px.length !== NFT_PIXELS) return;
      if (ref.current) drawNftToCanvas(px, palette, ref.current, 14);
    } catch {}
  })(); }, [id, pk, palette]);
  return (
    <div style={{ border:"1px solid #333", borderRadius:12, padding:10, background:"#161616" }}>
      <div style={{ fontSize:12, marginBottom:6, opacity:0.9 }}>ID #{id}</div>
      <canvas ref={ref} style={{ width:128, height:128, imageRendering:"pixelated", border:"1px solid #444", borderRadius:8, background:"#000" }}/>
    </div>
  );
}

function ListingCard({
  id, pk, palette, onBuyOk, notify
}:{
  id:number; pk:string; palette:number[] | null;
  onBuyOk?: ()=>void;
  notify: ReturnType<typeof useNotify>["notify"];
}) {
  const [info,setInfo] = useState<{seller:string; price:string}|null>(null);
  const canvasRef = useRef<HTMLCanvasElement|null>(null);

  useEffect(()=>{ (async()=>{
    try {
      const opt = await marketGet(pk, id) as any | null;
      if (opt && opt.length === 2) {
        const [seller, price] = opt;
        setInfo({ seller, price: String(price) });
      } else setInfo(null);

      if (palette) {
        const pixels = (await readNftValue(pk, id)) as Uint8Array;
        if (pixels.length === NFT_PIXELS && canvasRef.current) {
          drawNftToCanvas(pixels, palette, canvasRef.current, 14);
        }
      }
    } catch (e:any) {
      notify.err("Không tải được thông tin listing #" + id + "\n" + (e.message || String(e)));
    }
  })(); // eslint-disable-next-line
  }, [id, pk, palette]);

  if (!info) return (
    <div style={{ border:"1px solid #333", borderRadius:12, padding:12, background:"#161616" }}>
      ID #{id}: chưa có thông tin (không list?)
    </div>
  );

  return (
    <div style={{ border:"1px solid #333", borderRadius:12, padding:12, background:"#161616" }}>
      <div style={{ display:"flex", gap:12 }}>
        <canvas ref={canvasRef} style={{ width:128, height:128, imageRendering:"pixelated", border:"1px solid #444", borderRadius:8, background:"#000" }}/>
        <div style={{ fontSize:13 }}>
          <div><b>ID:</b> {id}</div>
          <div style={{ wordBreak:"break-all" }}><b>Seller:</b> {info.seller}</div>
          <div><b>Price (raw):</b> {info.price}</div>
        </div>
      </div>
      <div style={{ display:"flex", gap:8, marginTop:8 }}>
        <button
          style={{ background:"#2ecc71", border:"none", color:"white", borderRadius:8, padding:"8px 12px", cursor:"pointer" }}
          onClick={async()=>{
            try {
              const res = await marketBuy(pk, pk, id);
              notify.ok("Mua thành công ID #" + id + "\n" + JSON.stringify(res));
              onBuyOk?.();
            } catch (e:any) {
              notify.err("Mua thất bại ID #" + id + "\n" + (e.message || String(e)));
            }
          }}
        >Mua</button>
      </div>
    </div>
  );
}

/* =========================================================
 * APP CHÍNH — BỐ CỤC RÕ TỪNG PHẦN + THÔNG BÁO
 * =======================================================*/
export default function App() {
  // notify
  const { items, notify, remove } = useNotify();

  // ví & token
  const [pk, setPk] = useState("");
  const [name, setName] = useState("-");
  const [symbol, setSymbol] = useState("-");
  const [decimals, setDecimals] = useState<number>(0);
  const [supply, setSupply] = useState<string>("-");
  const [balance, setBalance] = useState<string>("0");

  // NFT preview (1 id) + palette
  const [nftId, setNftId] = useState<string>("");
  const [palette, setPalette] = useState<number[] | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // My NFTs
  const [myIds, setMyIds] = useState<number[]>([]);

  // Mint
  const [mintPixels, setMintPixels] = useState<string>("");
  const [mintTo, setMintTo] = useState<string>("");
  const mintPreviewRef = useRef<HTMLCanvasElement | null>(null);

  // Market
  const [listIds, setListIds] = useState<number[]>([]);

  // activity (nhẹ, tùy xoá)
  const [activity, setActivity] = useState<string>("");

  const pal = usePal(palette);

  // styles chung
  const centerWrap: React.CSSProperties = useMemo(()=>({
    minHeight:"100vh", display:"flex", alignItems:"start", justifyContent:"center",
    background:"linear-gradient(160deg, #0d0d0f, #121212, #1a1a1d)", color:"#f2f2f2",
    fontFamily:"Inter, Arial", padding:24
  }), []);
  const card: React.CSSProperties = useMemo(()=>({
    width:"100%", maxWidth:1180, border:"1px solid #2b2b2b", borderRadius:16, background:"#1e1e1e",
    boxShadow:"0 0 40px rgba(0,0,0,0.6)", padding:24, display:"grid", gap:16
  }), []);
  const input: React.CSSProperties = { background:"#2a2a2a", border:"1px solid #444", color:"white", borderRadius:6, padding:"10px 12px" };
  const btn: React.CSSProperties = { background:"#007aff", border:"none", color:"white", borderRadius:8, fontSize:15, cursor:"pointer", padding:"10px 12px" };

  /* --------------------------- helpers --------------------------- */
  const setAct = (s: string) => setActivity((p)=> (p? p+"\n" : "") + s);

  const connect = async () => {
    try {
      const pub = await connectWallet();
      await assertNetwork();
      setPk(pub);
      notify.ok("Đã kết nối ví:\n" + pub);
    } catch (e:any) {
      notify.err("Kết nối ví thất bại:\n" + (e.message || String(e)));
    }
  };

  const loadInfo = async () => {
    if (!pk) { notify.warn("Chưa kết nối ví."); return; }
    try {
      const [n, s, d, sup, bal, palFromChain] = await Promise.all([
        readName(pk), readSymbol(pk), readDecimals(pk), readTotalSupply(pk), readBalanceOf(pk, pk), readPalette(pk)
      ]);
      setName(String(n)); setSymbol(String(s)); setDecimals(Number(d));
      setSupply(String(sup)); setBalance(String(bal));
      setPalette((palFromChain as number[]) || DEFAULT_PALETTE);
      notify.ok("Đã tải token + palette.");
    } catch (e:any) {
      setPalette(DEFAULT_PALETTE);
      notify.err("Đọc thông tin thất bại. Đang dùng palette mặc định.\n" + (e.message || String(e)));
    }
  };

  useEffect(()=>{ if (pk) loadInfo(); /* eslint-disable-next-line */ }, [pk]);

  const doTokenTransfer = async (to: string, amt: string) => {
    if (!pk) { notify.warn("Chưa kết nối ví."); return; }
    try {
      const res = await tokenTransfer(pk, pk, to.trim(), BigInt(amt));
      notify.ok("Chuyển token OK:\n" + JSON.stringify(res));
      const bal = await readBalanceOf(pk, pk);
      setBalance(String(bal));
    } catch (e:any) {
      notify.err("Chuyển token thất bại:\n" + (e.message || String(e)));
    }
  };

  const loadNft = async () => {
    if (!pk) { notify.warn("Chưa kết nối ví."); return; }
    try {
      const idNum = Number(nftId);
      if (!Number.isInteger(idNum) || idNum < 0) throw new Error("ID không hợp lệ");
      const pixels = await readNftValue(pk, idNum) as Uint8Array;
      if (pixels.length !== NFT_PIXELS) throw new Error("NFT không phải 9×9.");
      const canvas = canvasRef.current!;
      drawNftToCanvas(pixels, pal, canvas, 28);
      notify.ok("Preview NFT #" + idNum + " OK.");
    } catch (e:any) {
      notify.err("Preview NFT thất bại:\n" + (e.message || String(e)));
    }
  };

  const loadMyNfts = async () => {
    if (!pk) { notify.warn("Chưa kết nối ví."); return; }
    try {
      const ids = await readNftIdsOf(pk, pk) as number[];
      setMyIds(ids || []);
      notify.info(`Đã tải NFT của bạn: ${ids?.length || 0} item(s).`);
    } catch (e:any) {
      notify.err("Tải NFT của bạn thất bại:\n" + (e.message || String(e)));
    }
  };

  const refreshListings = async () => {
    if (!pk) { notify.warn("Chưa kết nối ví."); return; }
    try {
      const ids = await marketListIds(pk) as number[];
      setListIds(ids || []);
      notify.info(`Đã tải danh sách đang bán: ${ids?.length || 0} item(s).`);
    } catch (e:any) {
      notify.err("Load listings thất bại:\n" + (e.message || String(e)));
    }
  };

  const previewMint = () => {
    try {
      const px = parsePixelsFlex9x9(mintPixels);
      if (px.length !== NFT_PIXELS) throw new Error("Không phải ma trận 9×9");
      if (mintPreviewRef.current) drawNftToCanvas(px, pal, mintPreviewRef.current, 14);
      notify.ok("Preview mint OK.");
    } catch (e:any) {
      notify.err("Preview mint thất bại:\n" + (e.message || String(e)));
    }
  };

  const doMint = async () => {
    if (!pk) { notify.warn("Chưa kết nối ví."); return; }
    try {
      const to = (mintTo || pk).trim();
      const res = await mintNftFlex(pk, to, mintPixels);
      notify.ok("Mint thành công:\n" + JSON.stringify(res));
      try {
        const ids = await readNftIdsOf(pk, pk) as number[];
        setMyIds(ids || []);
      } catch {}
    } catch (e:any) {
      notify.err("Mint thất bại:\n" + (e.message || String(e)));
    }
  };

  const doList = async (idStr: string, priceStr: string) => {
    if (!pk) { notify.warn("Chưa kết nối ví."); return; }
    try {
      const id = Number(idStr);
      const pr = BigInt(priceStr);
      const res = await marketList(pk, pk, id, pr);
      notify.ok("Đăng bán OK:\n" + JSON.stringify(res));
      refreshListings();
    } catch (e:any) {
      notify.err("Đăng bán thất bại:\n" + (e.message || String(e)));
    }
  };

  const doCancel = async (idStr: string) => {
    if (!pk) { notify.warn("Chưa kết nối ví."); return; }
    try {
      const id = Number(idStr);
      const res = await marketCancel(pk, pk, id);
      notify.ok("Huỷ bán OK:\n" + JSON.stringify(res));
      refreshListings();
    } catch (e:any) {
      notify.err("Huỷ bán thất bại:\n" + (e.message || String(e)));
    }
  };

  const doBuy = async (idStr: string) => {
    if (!pk) { notify.warn("Chưa kết nối ví."); return; }
    try {
      const id = Number(idStr);
      const res = await marketBuy(pk, pk, id);
      notify.ok("Mua OK:\n" + JSON.stringify(res));
      refreshListings();
    } catch (e:any) {
      notify.err("Mua thất bại:\n" + (e.message || String(e)));
    }
  };

  /* =========================================================
   * BATCH TRANSFER
   * =======================================================*/
  type BatchRow = { line: number; to: string; amountRaw: bigint; original: string; error?: string };

  const [batchText, setBatchText] = useState<string>("");
  const [batchRows, setBatchRows] = useState<BatchRow[]>([]);
  const [batchIsToken, setBatchIsToken] = useState<boolean>(false); // true = nhập theo token
  const [batchTotal, setBatchTotal] = useState<bigint>(0n);
  const [batchOkCount, setBatchOkCount] = useState<number>(0);
  const [batchHasErrors, setBatchHasErrors] = useState<boolean>(false);

  const GADDR_RE = /^G[A-Z0-9]{55}$/;
  const pow10 = (n:number) => { let r = 1n; for (let i=0;i<n;i++) r *= 10n; return r; };

  function parseBatchText(text: string, asToken: boolean, d: number): { rows: BatchRow[], total: bigint } {
    const lines = text.split(/\r?\n/);
    const rows: BatchRow[] = [];
    let total = 0n;
    const mul = asToken ? pow10(d) : 1n;

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].trim();
      if (!raw) continue;

      // Tách theo tab / dấu phẩy / nhiều khoảng trắng
      const parts = raw.split(/[\t, ]+/).filter(Boolean);
      if (parts.length < 2) {
        rows.push({ line: i+1, to: "", amountRaw: 0n, original: raw, error: "Thiếu cột số lượng" });
        continue;
      }

      const to = parts[0].trim();
      let amtStr = parts[1].replace(/_/g, "").trim();

      let amountRaw: bigint;
      try {
        if (asToken && amtStr.includes(".")) {
          // chuẩn hóa phần thập phân theo decimals
          const [intP, fracP=""] = amtStr.split(".");
          if (!/^\d+$/.test(intP || "0") || !/^\d+$/.test(fracP || "0")) throw new Error("Số không hợp lệ");
          const fracPad = (fracP + "0".repeat(d)).slice(0, d);
          amountRaw = BigInt(intP || "0") * mul + BigInt(fracPad || "0");
        } else {
          // raw hoặc token nguyên
          if (!/^\d+$/.test(amtStr)) throw new Error("Số không hợp lệ");
          amountRaw = BigInt(amtStr) * mul;
        }
      } catch {
        rows.push({ line: i+1, to, amountRaw: 0n, original: raw, error: "Số lượng không hợp lệ" });
        continue;
      }

      if (!GADDR_RE.test(to)) {
        rows.push({ line: i+1, to, amountRaw, original: raw, error: "Địa chỉ G... không hợp lệ" });
        continue;
      }
      if (amountRaw <= 0n) {
        rows.push({ line: i+1, to, amountRaw, original: raw, error: "Số lượng phải > 0" });
        continue;
      }

      rows.push({ line: i+1, to, amountRaw, original: raw });
      total += amountRaw;
    }

    return { rows, total };
  }

  const analyzeBatch = () => {
    const { rows, total } = parseBatchText(batchText, batchIsToken, decimals || 0);
    setBatchRows(rows);
    setBatchTotal(total);
    const errs = rows.filter(r => r.error).length;
    setBatchHasErrors(errs > 0);
    setBatchOkCount(rows.length - errs);
    if (rows.length === 0) notify.warn("Không có dòng hợp lệ.");
    else notify.info(`Parsed ${rows.length} dòng (${rows.length - errs} OK, ${errs} lỗi).`);
  };

  const runBatchTransfer = async () => {
    if (!pk) { notify.warn("Chưa kết nối ví."); return; }
    if (batchRows.length === 0) { notify.warn("Chưa có dữ liệu batch."); return; }

    let ok = 0, fail = 0;
    for (const r of batchRows) {
      if (r.error) { fail++; continue; }
      try {
        await tokenTransfer(pk, pk, r.to, r.amountRaw);  // gửi tuần tự
        ok++;
        setAct(`OK line ${r.line}: ${r.to} ← ${r.amountRaw.toString()} (raw)`);
      } catch (e:any) {
        fail++;
        setAct(`FAIL line ${r.line}: ${r.to} ← ${r.amountRaw.toString()} | ${e?.message || e}`);
      }
    }
    try {
      const bal = await readBalanceOf(pk, pk);
      setBalance(String(bal));
    } catch {}

    notify.ok(`Batch xong: ${ok} thành công, ${fail} lỗi.`);
  };

  /* --------------------------- UI --------------------------- */
  return (
    <div style={centerWrap}>
      <div style={card}>
        <NotificationCenter items={items} remove={remove}/>

        {/* ===== Header / Connect ===== */}
        <Section
          title="💠 NFT Token DApp"
          actions={
            !pk ? (
              <button style={btn} onClick={connect}>Kết nối Freighter</button>
            ) : (
              <>
                <span style={{ fontSize:12, opacity:.85, border:"1px solid #333", padding:"6px 8px", borderRadius:6 }}>
                  <b>Wallet:</b> <span style={{ wordBreak:"break-all" }}>{pk}</span>
                </span>
                <button style={{ ...btn, background:"#28a745" }} onClick={loadInfo}>Tải thông tin</button>
              </>
            )
          }
        >
          <div style={{ fontSize:13, opacity:.8 }}>
            App chia thành các phần độc lập: Token, Chuyển token, Batch transfer, NFT, Palette, Mint, Marketplace.
            Tất cả lỗi/thành công hiển thị bằng thông báo ở góc phải.
          </div>
        </Section>

        {/* ===== Token ===== */}
        <Section title="Token">
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>
            <div style={{ border:"1px solid #333", borderRadius:12, padding:12, background:"#141414" }}>
              <div><b>Name:</b> {name}</div>
              <div><b>Symbol:</b> {symbol}</div>
              <div><b>Decimals:</b> {decimals}</div>
              <div><b>TotalSupply (raw):</b> {supply}</div>
            </div>
            <div style={{ border:"1px solid #333", borderRadius:12, padding:12, background:"#141414" }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <h4 style={{ margin:"0 0 8px 0" }}>Số dư của bạn</h4>
                <div style={{ fontSize:22, fontWeight:700, color:"#00e0ff" }}>{balance}</div>
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 140px", gap:8 }}>
                <input placeholder="G... nhận" style={input} id="tok_to"/>
                <input placeholder="Amount raw" style={input} id="tok_amt"/>
                <button style={btn} onClick={()=>{
                  const to=(document.getElementById("tok_to") as HTMLInputElement).value;
                  const amt=(document.getElementById("tok_amt") as HTMLInputElement).value;
                  if (!to || !amt) return notify.warn("Thiếu địa chỉ hoặc số lượng.");
                  doTokenTransfer(to, amt);
                }}>Gửi token</button>
              </div>
            </div>
          </div>
        </Section>

        {/* ===== Batch Transfer ===== */}
        <Section title="Chuyển token hàng loạt">
          <div style={{ display:"grid", gap:8 }}>
            <div style={{ fontSize:12, opacity:.85 }}>
              Dán dữ liệu: <code>G... [tab|dấu phẩy|space] amount</code> — ví dụ:
              <pre style={{ margin: "6px 0", background:"#111", padding:8, borderRadius:6 }}>
GBKBACMKBLAQQOYB2CGJHS3ONDI73SXSJWNJ5MNVHOXEGKZSUXC3E47P	150000
GB7VCPT6EEMK3ZKE2SGI5BA7YDGFUX6F7QU47W2TFIHPBGPG7GWRBSJJ	150000
GAMY3VPG5SFCXM26AA5AMLJKN64Y7GJUNVRUO5VFKHV6OZGVS76YVJBH	150000
              </pre>
              Mặc định đọc <b>raw</b>. Nếu bạn nhập theo <b>token</b> (có thể có số thập phân), bật “Token mode”.
            </div>

            <textarea
              placeholder="Dán list địa chỉ và số lượng..."
              style={{ ...input, height:140 }}
              value={batchText}
              onChange={e=>setBatchText(e.target.value)}
            />

            <div style={{ display:"flex", gap:12, alignItems:"center", flexWrap:"wrap" }}>
              <label style={{ display:"flex", alignItems:"center", gap:8 }}>
                <input type="checkbox" checked={batchIsToken} onChange={e=>setBatchIsToken(e.target.checked)} />
                Nhập theo <b>token</b> (sẽ nhân 10^{decimals})
              </label>
              <button style={{ ...btn, background:"#009688" }} onClick={analyzeBatch}>Phân tích</button>
              <div style={{ fontSize:12, opacity:.9 }}>
                {batchRows.length>0 && (
                  <>
                    <b>{batchRows.length}</b> dòng | <b>{batchOkCount}</b> OK,{" "}
                    <b style={{ color: batchHasErrors ? "#f39c12" : "#aaa" }}>
                      {batchRows.length - batchOkCount}
                    </b> lỗi | Tổng (raw): <b style={{ color:"#00e0ff" }}>{batchTotal.toString()}</b>
                  </>
                )}
              </div>
            </div>

            {batchRows.length>0 && (
              <div style={{ border:"1px solid #333", borderRadius:10, overflow:"hidden" }}>
                <div style={{ display:"grid", gridTemplateColumns:"60px 1fr 260px 1fr", gap:0, background:"#151515", padding:"8px 10px", fontWeight:600 }}>
                  <div>#</div><div>Địa chỉ</div><div>Số lượng (raw)</div><div>Trạng thái</div>
                </div>
                <div style={{ maxHeight:240, overflow:"auto" }}>
                  {batchRows.map((r, idx)=>(
                    <div key={idx} style={{ display:"grid", gridTemplateColumns:"60px 1fr 260px 1fr", gap:0, padding:"6px 10px", borderTop:"1px solid #222", background:r.error ? "#1d1212" : "#121a12" }}>
                      <div>{r.line}</div>
                      <div style={{ wordBreak:"break-all" }}>{r.to || <i>(n/a)</i>}</div>
                      <div>{r.amountRaw.toString()}</div>
                      <div style={{ color: r.error ? "#e74c3c" : "#2ecc71" }}>
                        {r.error ? r.error : "OK"}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ display:"flex", gap:8 }}>
              <button
                style={{ ...btn, background:"#2ecc71" }}
                disabled={batchRows.length===0}
                onClick={runBatchTransfer}
              >
                Gửi tất cả (tuần tự)
              </button>
              <button
                style={{ ...btn, background:"#555" }}
                onClick={()=>{
                  setBatchText(""); setBatchRows([]); setBatchTotal(0n);
                  setBatchOkCount(0); setBatchHasErrors(false);
                }}
              >
                Xoá
              </button>
            </div>
          </div>
        </Section>

        {/* ===== NFT: Preview 1 ID ===== */}
        <Section title="NFT — Preview 1 ID">
          <div style={{ display:"grid", gridTemplateColumns:"1fr 120px", gap:12, alignItems:"center" }}>
            <input placeholder="NFT ID (u32)" style={input} value={nftId} onChange={e=>setNftId(e.target.value)}/>
            <button style={{ ...btn, background:"#7c4dff" }} onClick={loadNft}>Tải NFT</button>
          </div>
          <div style={{ display:"flex", justifyContent:"center", marginTop: 12 }}>
            <canvas ref={canvasRef} style={{ width:256, height:256, imageRendering:"pixelated", border:"1px solid #444", borderRadius:8, background:"#000" }}/>
          </div>
        </Section>

        {/* ===== NFT: của bạn ===== */}
        <Section
          title="NFT của bạn"
          actions={
            <>
              <button style={{ ...btn, background:"#00bcd4" }} onClick={loadMyNfts}>🔍 Tải NFT hiện có</button>
              <button style={{ ...btn, background:"#555" }} onClick={()=>setMyIds([])}>Xoá danh sách</button>
            </>
          }
        >
          <div style={{ marginTop:12, display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))", gap:12 }}>
            {myIds.length === 0 ? (
              <div style={{ opacity:0.75 }}>Chưa có dữ liệu hiển thị.</div>
            ) : (
              myIds.map((id)=>(<MyNftThumb key={id} id={id} pk={pk} palette={palette}/>))
            )}
          </div>
        </Section>

        {/* ===== Palette ===== */}
        <Section
          title="Palette (32 màu)"
          actions={
            <button
              style={{ ...btn, background:"#009688" }}
              onClick={async()=> {
                if (!pk) { notify.warn("Chưa kết nối ví."); return; }
                try {
                  const palOnChain = await readPalette(pk);
                  setPalette((palOnChain as number[]) || DEFAULT_PALETTE);
                  notify.ok("Palette loaded từ contract.");
                } catch {
                  setPalette(DEFAULT_PALETTE);
                  notify.warn("Không đọc được palette. Đã reset về DB32.");
                }
              }}
            >🔄 Tải/Reset palette</button>
          }
        >
          <div style={{ display:"grid", gridTemplateColumns:"repeat(16, 1fr)", gap:6 }}>
            {pal.map((c, i)=>(
              <div key={i} title={`#${c.toString(16).padStart(6,"0")}`}
                   style={{ background:"#"+c.toString(16).padStart(6,"0"), height:18, border:"1px solid #333", borderRadius:4 }}/>
            ))}
          </div>
        </Section>

        {/* ===== Mint ===== */}
        <Section title="Mint NFT (Admin) — 9×9×32">
          <div style={{ display:"grid", gridTemplateColumns:"1fr 240px", gap:12, alignItems:"start" }}>
            <div style={{ display:"grid", gap:8 }}>
              <textarea
                placeholder="Dán lưới 9×9 (tab/space/dấu phẩy; mỗi hàng 1 dòng) hoặc hex162"
                style={{ ...input, height:140 }}
                value={mintPixels}
                onChange={e=>setMintPixels(e.target.value)}
              />
              <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                <button style={{ ...btn, background:"#7c4dff" }} onClick={previewMint}>👀 Xem trước</button>
                <button style={{ ...btn, background:"#ff8c00" }} onClick={doMint}>🧱 Mint</button>
              </div>
            </div>
            <div style={{ display:"grid", gap:8 }}>
              <input
                placeholder="To (G...) - trống = chính bạn"
                style={input}
                value={mintTo}
                onChange={e=>setMintTo(e.target.value)}
              />
              <div style={{ fontSize:12, opacity:0.8 }}>Preview</div>
              <canvas
                ref={mintPreviewRef}
                style={{ width:128, height:128, imageRendering:"pixelated", border:"1px solid #444", borderRadius:8, background:"#000" }}
              />
            </div>
          </div>
        </Section>

        {/* ===== Chuyển NFT ===== */}
        <Section title="Chuyển NFT">
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 140px", gap:8 }}>
            <input placeholder="NFT ID (u32)" style={input} id="tx_nft_id" />
            <input placeholder="Địa chỉ nhận (G...)" style={input} id="tx_to" />
            <button
              style={{ ...btn, background:"#f39c12" }}
              onClick={async()=>{
                if (!pk) { notify.warn("Chưa kết nối ví."); return; }
                try {
                  const idStr = (document.getElementById("tx_nft_id") as HTMLInputElement).value.trim();
                  const to    = (document.getElementById("tx_to") as HTMLInputElement).value.trim();
                  if (!idStr) throw new Error("Thiếu NFT ID");
                  if (!/^G[A-Z0-9]{55}$/.test(to)) throw new Error("Địa chỉ nhận không hợp lệ");
                  const id = Number(idStr);
                  const res = await nftTransfer(pk, pk, to, id);
                  notify.ok("Chuyển NFT OK:\n" + JSON.stringify(res));
                  try { const ids = await readNftIdsOf(pk, pk) as number[]; setMyIds(ids||[]); } catch {}
                } catch (e:any) {
                  notify.err("NFT transfer fail:\n" + (e.message || String(e)));
                }
              }}
            >Chuyển</button>
          </div>
          <p style={{fontSize:12, opacity:.8, marginTop:8}}>
            Lưu ý: Phải là chủ sở hữu hiện tại. Nếu NFT đang được list, chuyển sẽ bị chặn.
          </p>
        </Section>

        {/* ===== Marketplace ===== */}
        <Section title="Marketplace">
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
            <div style={{ border:"1px solid #333", borderRadius:12, padding:12, background:"#141414" }}>
              <h4 style={{ margin:"6px 0" }}>Đăng bán</h4>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 120px", gap:8 }}>
                <input placeholder="NFT ID" style={input} id="list_id" />
                <input placeholder="Price (raw)" style={input} id="list_price" />
                <button style={btn} onClick={()=>{
                  const id=(document.getElementById("list_id") as HTMLInputElement).value;
                  const pr=(document.getElementById("list_price") as HTMLInputElement).value;
                  if (!id || !pr) return notify.warn("Thiếu ID hoặc giá.");
                  doList(id, pr);
                }}>Đăng</button>
              </div>
              <div style={{ marginTop:8, display:"grid", gridTemplateColumns:"1fr 120px", gap:8 }}>
                <input placeholder="NFT ID" style={input} id="cancel_id" />
                <button style={{ ...btn, background:"#e74c3c" }} onClick={()=>{
                  const id=(document.getElementById("cancel_id") as HTMLInputElement).value;
                  if (!id) return notify.warn("Thiếu ID cần huỷ.");
                  doCancel(id);
                }}>Huỷ</button>
              </div>
            </div>

            <div style={{ border:"1px solid #333", borderRadius:12, padding:12, background:"#141414" }}>
              <h4 style={{ margin:"6px 0" }}>Mua nhanh</h4>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 120px", gap:8 }}>
                <input placeholder="NFT ID" style={input} id="buy_id" />
                <button style={{ ...btn, background:"#2ecc71" }} onClick={()=>{
                  const id=(document.getElementById("buy_id") as HTMLInputElement).value;
                  if (!id) return notify.warn("Thiếu ID cần mua.");
                  doBuy(id);
                }}>Mua</button>
              </div>
              <div style={{ marginTop:8 }}>
                <button style={{ ...btn, background:"#555" }} onClick={refreshListings}>Tải danh sách đang bán</button>
              </div>
            </div>
          </div>

          <div style={{ marginTop:12, display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))", gap:12 }}>
            {listIds.map((id)=>(
              <ListingCard key={id} id={id} pk={pk} palette={palette} notify={notify} onBuyOk={refreshListings}/>
            ))}
          </div>
        </Section>

        {/* ===== Activity nhỏ (tùy chọn) ===== */}
        <Section title="Activity (gọn)" >
          <pre style={{ whiteSpace:"pre-wrap", fontSize:12, color:"#bbb", background:"#111", padding:12, borderRadius:8, margin:0, maxHeight:220, overflow:"auto" }}>
            {activity || "Chưa có log."}
          </pre>
        </Section>
      </div>
    </div>
  );
}
