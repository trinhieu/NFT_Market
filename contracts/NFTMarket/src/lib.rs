#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, log, symbol_short,
    Address, Bytes, Env, Symbol, String, Vec,
};


// ========== Token keys ==========
const ADMIN:    Symbol = symbol_short!("ADM");   // Địa chỉ admin (cần auth cho admin-only)
const NAME:     Symbol = symbol_short!("NAME");  // Tên token FT
const SYMBOL_:  Symbol = symbol_short!("SYMB");  // Ký hiệu token FT
const DECIMALS: Symbol = symbol_short!("DEC");   // Số lẻ thập phân token FT (<=18)
const SUPPLY:   Symbol = symbol_short!("SUP");   // Tổng cung FT
const INITED:   Symbol = symbol_short!("INI");   // Đã init hay chưa
const BAL:      Symbol = symbol_short!("BAL");   // (BAL, Address) → i128 số dư FT

// ========== NFT keys ==========
const NFT_SUP:  Symbol = symbol_short!("NSUP");  // Tổng số NFT đã mint (i128)
const NFT_MAX:  i128  = 10_000;                  // Giới hạn max supply NFT
const NEXT_ID:  Symbol = symbol_short!("NID");   // ID NFT tiếp theo (i128)
const NFT:      Symbol = symbol_short!("NFT");   // (NFT, id:u32) → NftData
const OWN:      Symbol = symbol_short!("OWN");   // (OWN, owner:Address) → Vec<u32> (danh sách id)
const PAL:      Symbol = symbol_short!("PAL");   // Bảng màu Vec<u32> (32 màu 0xRRGGBB)

// Uniqueness & Search index
const UNIQ:     Symbol = symbol_short!("UNIQ");  // (UNIQ, pixels:Bytes) → id (đảm bảo độc nhất theo pixel)
const IDX:      Symbol = symbol_short!("IDX");   // (IDX, pos:u32, col:u32) → Vec<u32> (IDs có màu col ở vị trí pos)

// ========== Marketplace keys ==========
const LST:      Symbol = symbol_short!("LST");   // (LST, id) → Listing (thông tin listing)
const LIDS:     Symbol = symbol_short!("LIDS");  // Vec<u32> danh sách id đang niêm yết
const LSTFEE:   Symbol = symbol_short!("LFEE");  // Phí listing (i128, tính bằng “raw” theo decimals FT)

// ===== Transfer fee: cố định 1 “raw” (0.001 token vì decimals=3) =====
const TRANSFER_FEE_RAW: i128 = 1;

// ✅ Để FALSE: không đánh index toàn bộ khi mint (tránh vượt footprint simulate)
const ENABLE_POS_INDEX: bool = false;

// ========== Cấu hình kích thước NFT ==========
const NFT_SIZE:   u32 = 9;
const NFT_PIXELS: u32 = NFT_SIZE * NFT_SIZE; // 81


#[contracttype]
#[derive(Clone)]
pub struct NftData {
    pub owner: Address,
    pub pixels: Bytes,
}

#[contracttype]
#[derive(Clone)]
pub struct Listing {
    pub seller: Address,
    pub price: i128,
}


#[contract]
pub struct SimpleTokenNft;

#[contractimpl]
impl SimpleTokenNft {

    // init
    pub fn init(env: Env, admin: Address, name: String, symbol: String, decimals: u32) {
        if env.storage().instance().has(&INITED) { panic!("ALREADY_INIT"); }
        admin.require_auth();

        // Bắt buộc 3 chữ số thập phân
        if decimals != 3 { panic!("DECIMALS_MUST_BE_3"); }

        // Tổng cung = 100_000_000_000 * 10^3 = 100_000_000_000_000 (raw)
        let total: i128 = mul_pow10_i128(100_000_000_000i128, decimals).expect("SUPPLY_OVERFLOW");

        // Lưu metadata token
        env.storage().instance().set(&ADMIN, &admin);
        env.storage().instance().set(&NAME, &name);
        env.storage().instance().set(&SYMBOL_, &symbol);
        env.storage().instance().set(&DECIMALS, &decimals);
        env.storage().instance().set(&SUPPLY, &total);
        env.storage().instance().set(&INITED, &true);

        // Cấp FT cho admin
        env.storage().persistent().set(&(BAL, &admin), &total);

        // Palette & marketplace defaults
        env.storage().instance().set(&PAL, &default_palette(&env));
        env.storage().instance().set(&NFT_SUP, &0i128);
        env.storage().instance().set(&NEXT_ID, &0i128);
        env.storage().instance().set(&LSTFEE, &1i128); // 0.001 token (raw)
        let empty_ids: Vec<u32> = Vec::new(&env);
        env.storage().instance().set(&LIDS, &empty_ids);

        log!(&env, "INIT OK supply={} (decimals=3) transfer_fee=0.001 listing_fee=0.001", total);
    }

    // transfer (FT) — người gửi trả phí 0.001 token (1 raw)
    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        require_inited(&env);
        if amount <= 0 { panic!("BAD_AMOUNT"); }
        from.require_auth();
        if from == to { panic!("SELF_TRANSFER"); }

        let from_bal: i128 = env.storage().persistent().get(&(BAL, &from)).unwrap_or(0);
        let to_bal: i128 = env.storage().persistent().get(&(BAL, &to)).unwrap_or(0);
        let admin: Address = env.storage().instance().get(&ADMIN).unwrap();

        let fee: i128 = TRANSFER_FEE_RAW;
        let total_deduct = amount.checked_add(fee).expect("FEE_ADD_OVERFLOW");
        if from_bal < total_deduct { panic!("INSUFFICIENT_BALANCE_WITH_FEE"); }

        // Cập nhật to
        let new_to   = to_bal.checked_add(amount).expect("BAL_OVERFLOW");
        env.storage().persistent().set(&(BAL, &to),   &new_to);

        // Khấu trừ from
        let new_from = from_bal - total_deduct;
        env.storage().persistent().set(&(BAL, &from), &new_from);

        // Luôn cộng phí cho admin
        let admin_bal: i128 = env.storage().persistent().get(&(BAL, &admin)).unwrap_or(0);
        let new_admin = admin_bal.checked_add(fee).expect("BAL_OVERFLOW");
        env.storage().persistent().set(&(BAL, &admin), &new_admin);

        log!(&env, "TRANSFER: {} -> {} amount={} fee_raw={}", from, to, amount, fee);
    }

    // -------------------------------------------------------------------------
    // transfer_batch
    //   - Gửi token tới nhiều địa chỉ trong 1 lần gọi.
    //   - Người gửi trả phí cố định 1 raw / giao dịch.
    //   - Tổng khấu trừ = sum(amounts) + len(tos)*fee_raw.
    //   - Luôn cộng tổng phí cho admin để bảo toàn tổng cung.
    //   - Trả về tổng phí đã thu (raw).
    // -------------------------------------------------------------------------
    pub fn transfer_batch(env: Env, from: Address, tos: Vec<Address>, amounts: Vec<i128>) -> i128 {
        require_inited(&env);
        from.require_auth();

        let n = tos.len();
        if n == 0 { panic!("EMPTY_BATCH"); }
        if n != amounts.len() { panic!("LENGTH_MISMATCH"); }

        // Validate inputs & tính tổng amount
        let mut sum_amounts: i128 = 0;
        for i in 0..n {
            let to = tos.get_unchecked(i);
            let amt = amounts.get_unchecked(i);
            if amt <= 0 { panic!("BAD_AMOUNT_AT"); }
            if to == from { panic!("SELF_TRANSFER_AT"); }
            sum_amounts = sum_amounts.checked_add(amt).expect("AMOUNT_SUM_OVERFLOW");
        }

        let admin: Address = env.storage().instance().get(&ADMIN).unwrap();
        let fee_per: i128 = TRANSFER_FEE_RAW;
        let n_i128: i128 = n as i128;
        let total_fee: i128 = fee_per.checked_mul(n_i128).expect("FEE_MUL_OVERFLOW");
        let total_deduct: i128 = sum_amounts.checked_add(total_fee).expect("TOTAL_DEDUCT_OVERFLOW");

        // Kiểm tra số dư người gửi
        let from_bal: i128 = env.storage().persistent().get(&(BAL, &from)).unwrap_or(0);
        if from_bal < total_deduct { panic!("INSUFFICIENT_BALANCE_WITH_FEE"); }

        // Cộng cho từng người nhận
        for i in 0..n {
            let to = tos.get_unchecked(i);
            let amt = amounts.get_unchecked(i);
            let to_bal: i128 = env.storage().persistent().get(&(BAL, &to)).unwrap_or(0);
            let new_to = to_bal.checked_add(amt).expect("BAL_OVERFLOW");
            env.storage().persistent().set(&(BAL, &to), &new_to);
        }

        // Khấu trừ người gửi (một lần)
        let new_from = from_bal - total_deduct;
        env.storage().persistent().set(&(BAL, &from), &new_from);

        // Cộng tổng phí cho admin (một lần)
        let admin_bal: i128 = env.storage().persistent().get(&(BAL, &admin)).unwrap_or(0);
        let new_admin = admin_bal.checked_add(total_fee).expect("BAL_OVERFLOW");
        env.storage().persistent().set(&(BAL, &admin), &new_admin);

        log!(&env, "TRANSFER_BATCH: from={} n_recipients={} sum_amounts={} total_fee_raw={}", from, n, sum_amounts, total_fee);
        total_fee
    }

    /*-------------------------------------------------------------------------*
     | mint_nft (ADMIN)
     *-------------------------------------------------------------------------*/
    pub fn mint_nft(env: Env, to: Address, pixels: Bytes) -> u32 {
        require_inited(&env);
        let admin: Address = env.storage().instance().get(&ADMIN).unwrap();
        admin.require_auth();

        if pixels.len() != NFT_PIXELS { panic!("PIXELS_LEN_81"); }
        for i in 0..pixels.len() {
            let v = pixels.get_unchecked(i);
            if v > 31 { panic!("PIXEL_OUT_OF_RANGE"); }
        }

        if env.storage().persistent().has(&(UNIQ, &pixels)) {
            panic!("DUPLICATE_VALUE");
        }

        let cur: i128 = env.storage().instance().get(&NFT_SUP).unwrap_or(0);
        if cur >= NFT_MAX { panic!("NFT_MAX_SUP_REACHED"); }
        let next: i128 = env.storage().instance().get(&NEXT_ID).unwrap_or(0);
        if next >= i128::from(u32::MAX) { panic!("NFT_ID_EXHAUSTED"); }
        let id: u32 = next as u32;

        let data = NftData { owner: to.clone(), pixels: pixels.clone() };
        env.storage().persistent().set(&(NFT, id), &data);

        let mut list: Vec<u32> = env.storage().persistent().get(&(OWN, &to)).unwrap_or(Vec::new(&env));
        list.push_back(id);
        env.storage().persistent().set(&(OWN, &to), &list);

        env.storage().persistent().set(&(UNIQ, &pixels), &id);

        if ENABLE_POS_INDEX {
            for i in 0..NFT_PIXELS {
                let col: u32 = pixels.get_unchecked(i).into();
                let key = (IDX, i, col);
                let mut vec: Vec<u32> = env.storage().persistent().get(&key).unwrap_or(Vec::new(&env));
                vec.push_back(id);
                env.storage().persistent().set(&key, &vec);
            }
        }

        env.storage().instance().set(&NFT_SUP, &(cur + 1));
        env.storage().instance().set(&NEXT_ID, &(next + 1));

        log!(&env, "MINT_NFT id={} to={}", id, to);
        id
    }

    /*-------------------------------------------------------------------------*
     | nft_index_range (ADMIN)
     *-------------------------------------------------------------------------*/
    pub fn nft_index_range(env: Env, id: u32, start: u32, end: u32) {
        require_inited(&env);
        if end > NFT_PIXELS || start >= end { panic!("BAD_RANGE"); }

        let admin: Address = env.storage().instance().get(&ADMIN).unwrap();
        admin.require_auth();

        let data: NftData = env.storage().persistent().get(&(NFT, id)).expect("NFT_NOT_FOUND");
        let pixels = data.pixels;

        for i in start..end {
            let col: u32 = pixels.get_unchecked(i).into();
            let key = (IDX, i, col);
            let mut vec: Vec<u32> = env.storage().persistent().get(&key).unwrap_or(Vec::new(&env));
            vec.push_back(id);
            env.storage().persistent().set(&key, &vec);
        }

        log!(&env, "INDEX_RANGE id={} [{}..{})", id, start, end);
    }

    /*-------------------------------------------------------------------------*
     | nft_transfer
     *-------------------------------------------------------------------------*/
    pub fn nft_transfer(env: Env, from: Address, to: Address, id: u32) {
        require_inited(&env);
        from.require_auth();
        if from == to { panic!("SELF_TRANSFER"); }
        if env.storage().persistent().has(&(LST, id)) { panic!("LISTED"); }
        nft_transfer_internal(&env, from, to, id);
    }

    pub fn nft_total(env: Env) -> u32 {
        let cur: i128 = env.storage().instance().get(&NFT_SUP).unwrap_or(0);
        cur as u32
    }

    pub fn nft_get(env: Env, id: u32) -> (Address, Bytes) {
        let data: NftData = env.storage().persistent().get(&(NFT, id)).expect("NFT_NOT_FOUND");
        (data.owner, data.pixels)
    }

    pub fn nft_value(env: Env, id: u32) -> Bytes {
        let data: NftData = env.storage().persistent().get(&(NFT, id)).expect("NFT_NOT_FOUND");
        data.pixels
    }

    pub fn nft_find_by_value(env: Env, pixels: Bytes) -> Option<u32> {
        env.storage().persistent().get(&(UNIQ, &pixels))
    }

    pub fn nft_search_pos_color(env: Env, pos: u32, color: u32) -> Vec<u32> {
        if pos >= NFT_PIXELS { panic!("POS_RANGE_0_80"); }
        if color >= 32 { panic!("COLOR_RANGE_0_31"); }
        let key = (IDX, pos, color);
        env.storage().persistent().get(&key).unwrap_or(Vec::new(&env))
    }

    pub fn nft_ids_of(env: Env, owner: Address) -> Vec<u32> {
        env.storage().persistent().get(&(OWN, &owner)).unwrap_or(Vec::new(&env))
    }

    /*-------------------------------------------------------------------------*
     | Palette
     *-------------------------------------------------------------------------*/
    pub fn palette_get(env: Env) -> Vec<u32> {
        env.storage().instance().get(&PAL).expect("NO_PALETTE")
    }

    pub fn palette_set(env: Env, new_palette: Vec<u32>) {
        require_inited(&env);
        if new_palette.len() != 32 { panic!("PALETTE_32_REQUIRED"); }
        let admin: Address = env.storage().instance().get(&ADMIN).unwrap();
        admin.require_auth();
        env.storage().instance().set(&PAL, &new_palette);
        log!(&env, "PALETTE_UPDATED");
    }


    // Marketplace
    pub fn listing_fee_set(env: Env, fee: i128) {
        require_inited(&env);
        if fee < 0 { panic!("BAD_FEE"); }
        let admin: Address = env.storage().instance().get(&ADMIN).unwrap();
        admin.require_auth();
        env.storage().instance().set(&LSTFEE, &fee);
        log!(&env, "LISTING_FEE_SET {}", fee);
    }

    pub fn listing_fee_get(env: Env) -> i128 {
        env.storage().instance().get::<Symbol, i128>(&LSTFEE).unwrap_or(0)
    }

    pub fn market_list_nft(env: Env, seller: Address, id: u32, price: i128) {
        require_inited(&env);
        seller.require_auth();
        if price <= 0 { panic!("BAD_PRICE"); }

        let data: NftData = env.storage().persistent().get(&(NFT, id)).expect("NFT_NOT_FOUND");
        if data.owner != seller { panic!("NOT_OWNER"); }

        if env.storage().persistent().has(&(LST, id)) { panic!("ALREADY_LISTED"); }

        let fee: i128 = env.storage().instance().get(&LSTFEE).unwrap_or(0);
        if fee > 0 {
            let admin: Address = env.storage().instance().get(&ADMIN).unwrap();
            let mut seller_bal: i128 = env.storage().persistent().get(&(BAL, &seller)).unwrap_or(0);
            if seller_bal < fee { panic!("INSUFFICIENT_FOR_FEE"); }
            seller_bal -= fee;
            env.storage().persistent().set(&(BAL, &seller), &seller_bal);

            let admin_bal: i128 = env.storage().persistent().get(&(BAL, &admin)).unwrap_or(0);
            env.storage().persistent().set(&(BAL, &admin), &(admin_bal.checked_add(fee).expect("BAL_OVERFLOW")));
        }

        let lst = Listing { seller: seller.clone(), price };
        env.storage().persistent().set(&(LST, id), &lst);

        let mut ids: Vec<u32> = env.storage().instance().get(&LIDS).unwrap_or(Vec::new(&env));
        ids.push_back(id);
        env.storage().instance().set(&LIDS, &ids);

        log!(&env, "LIST id={} seller={} price={}", id, seller, price);
    }

    pub fn market_cancel(env: Env, seller: Address, id: u32) {
        require_inited(&env);
        seller.require_auth();

        let lst: Listing = env.storage().persistent().get(&(LST, id)).expect("NOT_LISTED");
        if lst.seller != seller { panic!("NOT_SELLER"); }

        env.storage().persistent().remove(&(LST, id));

        let mut ids: Vec<u32> = env.storage().instance().get(&LIDS).unwrap_or(Vec::new(&env));
        vec_remove_once(&env, &mut ids, id);
        env.storage().instance().set(&LIDS, &ids);

        log!(&env, "UNLIST id={} seller={}", id, seller);
    }

    pub fn market_buy(env: Env, buyer: Address, id: u32) {
        require_inited(&env);
        buyer.require_auth();

        let lst: Listing = env.storage().persistent().get(&(LST, id)).expect("NOT_LISTED");

        let data: NftData = env.storage().persistent().get(&(NFT, id)).expect("NFT_NOT_FOUND");
        if data.owner != lst.seller { panic!("LISTING_OWNER_MISMATCH"); }
        if buyer == lst.seller { panic!("SELF_BUY"); }
        if lst.price <= 0 { panic!("BAD_PRICE"); }

        let mut buyer_bal: i128 = env.storage().persistent().get(&(BAL, &buyer)).unwrap_or(0);
        if buyer_bal < lst.price { panic!("INSUFFICIENT_BALANCE"); }
        let mut seller_bal: i128 = env.storage().persistent().get(&(BAL, &lst.seller)).unwrap_or(0);

        buyer_bal -= lst.price;
        seller_bal = seller_bal.checked_add(lst.price).expect("BAL_OVERFLOW");
        env.storage().persistent().set(&(BAL, &buyer), &buyer_bal);
        env.storage().persistent().set(&(BAL, &lst.seller), &seller_bal);

        nft_transfer_internal(&env, lst.seller.clone(), buyer.clone(), id);

        env.storage().persistent().remove(&(LST, id));
        let mut ids: Vec<u32> = env.storage().instance().get(&LIDS).unwrap_or(Vec::new(&env));
        vec_remove_once(&env, &mut ids, id);
        env.storage().instance().set(&LIDS, &ids);

        log!(&env, "BUY id={} buyer={} price={}", id, buyer, lst.price);
    }

    pub fn market_get(env: Env, id: u32) -> Option<(Address, i128)> {
        let maybe: Option<Listing> = env.storage().persistent().get(&(LST, id));
        match maybe {
            Some(l) => Some((l.seller, l.price)),
            None => None,
        }
    }

    pub fn market_list_ids(env: Env) -> Vec<u32> {
        env.storage().instance().get(&LIDS).unwrap_or(Vec::new(&env))
    }


    // | Token read tiện ích
    pub fn name(env: Env) -> String {
        env.storage().instance().get::<Symbol, String>(&NAME).expect("NO_NAME")
    }
    pub fn symbol(env: Env) -> String {
        env.storage().instance().get::<Symbol, String>(&SYMBOL_).expect("NO_SYMBOL")
    }
    pub fn decimals(env: Env) -> u32 {
        env.storage().instance().get::<Symbol, u32>(&DECIMALS).expect("NO_DECIMALS")
    }
    pub fn total_supply(env: Env) -> i128 {
        env.storage().instance().get::<Symbol, i128>(&SUPPLY).expect("NO_SUPPLY")
    }
    pub fn balance_of(env: Env, of: Address) -> i128 {
        env.storage().persistent().get(&(BAL, &of)).unwrap_or(0)
    }
}


fn require_inited(env: &Env) {
    if !env.storage().instance().has(&INITED) { panic!("NOT_INITED"); }
}

// Xoá một phần tử “target” đầu tiên trong Vec<u32>
fn vec_remove_once(env: &Env, v: &mut Vec<u32>, target: u32) -> bool {
    let mut found = false;
    let mut out = Vec::new(env);
    for i in 0..v.len() {
        let x = v.get_unchecked(i);
        if !found && x == target { found = true; } else { out.push_back(x); }
    }
    *v = out;
    found
}

// Di chuyển NFT: from → to, cập nhật danh sách OWN và owner trong NFT(id)
fn nft_transfer_internal(env: &Env, from: Address, to: Address, id: u32) {
    if from == to { panic!("SELF_TRANSFER"); }
    let mut data: NftData = env.storage().persistent()
        .get(&(NFT, id))
        .expect("NFT_NOT_FOUND");
    if data.owner != from { panic!("NOT_OWNER"); }

    let mut from_list: Vec<u32> = env.storage().persistent()
        .get(&(OWN, &from))
        .unwrap_or(Vec::new(env));
    if !vec_remove_once(env, &mut from_list, id) { panic!("OWNERSHIP_CORRUPTED"); }
    env.storage().persistent().set(&(OWN, &from), &from_list);

    let mut to_list: Vec<u32> = env.storage().persistent()
        .get(&(OWN, &to))
        .unwrap_or(Vec::new(env));
    to_list.push_back(id);
    env.storage().persistent().set(&(OWN, &to), &to_list);

    data.owner = to.clone();
    env.storage().persistent().set(&(NFT, id), &data);
}

// Tính base * 10^decimals, kiểm tra overflow
fn mul_pow10_i128(base: i128, decimals: u32) -> Option<i128> {
    let mut x = base;
    for _ in 0..decimals { x = x.checked_mul(10)?; }
    Some(x)
}

// DB32 mặc định (0xRRGGBB)
fn default_palette(env: &Env) -> Vec<u32> {
    Vec::from_array(
        env,
        [
            0x000000, 0x222034, 0x45283C, 0x663931,
            0x8F563B, 0xDF7126, 0xD9A066, 0xEEC39A,
            0xFBF236, 0x99E550, 0x6ABE30, 0x37946E,
            0x4B692F, 0x524B24, 0x323C39, 0x3F3F74,
            0x306082, 0x5B6EE1, 0x639BFF, 0x5FCDE4,
            0xCBDBFC, 0xFFFFFF, 0x9BADB7, 0x847E87,
            0x696A6A, 0x595652, 0x76428A, 0xAC3232,
            0xD95763, 0xD77BBA, 0x8F974A, 0x8A6F30,
        ],
    )
}
