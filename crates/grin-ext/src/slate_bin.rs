//! Slate v4 compact binary serialization: the format slatepacks carry
//! when interoperating with external Grin wallets (grin-wallet CLI,
//! Niffler, Wallet 13 etc.).
//!
//! Ported byte-for-byte from `grin-wallet/libwallet/src/slate_versions/
//! v4_bin.rs` so produced bytes are bit-identical to what
//! `grin_wallet_libwallet`'s `SlateV4Bin` writer produces. Tested by
//! round-tripping our output through the reference deserializer.
//!
//! Format (high-level):
//!   ver.version            : u16 BE
//!   ver.block_header_version : u16 BE
//!   id                     : 16 raw UUID bytes
//!   sta                    : 1 byte state code (0..=6)
//!   off                    : 32 bytes blinding-factor offset
//!   opt_fields_status      : 1 byte bitmask + conditional fields
//!   sigs                   : 1-byte count + N×ParticipantData
//!   opt_structs_status     : 1 byte bitmask + conditional coms + proof
//!   feat_args              : 8 bytes lock_hgt, ONLY when feat == 2
//!                            (HeightLocked). NRD slates use feat=3
//!                            and write the relative-height into the
//!                            same lock_hgt slot.

use crate::slate::{
    CommitsV4, KernelFeaturesArgsV4, ParticipantDataV4, PaymentInfoV4, SlateStateV4, SlateV4,
    VersionCompatInfoV4,
};

// ============================================================================
// Tiny byte-vec writer/reader helpers
// ============================================================================
//
// Avoids std::io::Write so this module stays no_std-compatible if we ever
// build for embedded.

struct W {
    buf: Vec<u8>,
}

impl W {
    fn new() -> Self {
        Self { buf: Vec::with_capacity(700) }
    }
    fn u8(&mut self, v: u8) {
        self.buf.push(v);
    }
    fn u16(&mut self, v: u16) {
        self.buf.extend_from_slice(&v.to_be_bytes());
    }
    fn u64(&mut self, v: u64) {
        self.buf.extend_from_slice(&v.to_be_bytes());
    }
    fn bytes(&mut self, bs: &[u8]) {
        self.buf.extend_from_slice(bs);
    }
    fn into_inner(self) -> Vec<u8> {
        self.buf
    }
}

struct R<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> R<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }
    fn ensure(&self, n: usize) -> Result<(), String> {
        // Compare against the bytes that remain instead of `self.pos + n`:
        // `n` can be a counterparty-chosen length (see read_coms), and the
        // sum would overflow before the comparison could reject it. `pos`
        // never exceeds `len` because it only advances past a successful
        // ensure, so the subtraction cannot underflow.
        let remaining = self.data.len().saturating_sub(self.pos);
        if n > remaining {
            Err(format!(
                "slate bin: unexpected EOF at pos {} (need {} more, have {})",
                self.pos, n, remaining
            ))
        } else {
            Ok(())
        }
    }
    fn u8(&mut self) -> Result<u8, String> {
        self.ensure(1)?;
        let v = self.data[self.pos];
        self.pos += 1;
        Ok(v)
    }
    fn u16(&mut self) -> Result<u16, String> {
        self.ensure(2)?;
        let mut b = [0u8; 2];
        b.copy_from_slice(&self.data[self.pos..self.pos + 2]);
        self.pos += 2;
        Ok(u16::from_be_bytes(b))
    }
    fn u64(&mut self) -> Result<u64, String> {
        self.ensure(8)?;
        let mut b = [0u8; 8];
        b.copy_from_slice(&self.data[self.pos..self.pos + 8]);
        self.pos += 8;
        Ok(u64::from_be_bytes(b))
    }
    fn fixed<const N: usize>(&mut self) -> Result<[u8; N], String> {
        self.ensure(N)?;
        let mut b = [0u8; N];
        b.copy_from_slice(&self.data[self.pos..self.pos + N]);
        self.pos += N;
        Ok(b)
    }
    fn bytes(&mut self, n: usize) -> Result<&'a [u8], String> {
        self.ensure(n)?;
        let s = &self.data[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }
}

// ============================================================================
// Field encoders
// ============================================================================

fn state_byte(s: SlateStateV4) -> u8 {
    match s {
        SlateStateV4::Unknown => 0,
        SlateStateV4::Standard1 => 1,
        SlateStateV4::Standard2 => 2,
        SlateStateV4::Standard3 => 3,
        SlateStateV4::Invoice1 => 4,
        SlateStateV4::Invoice2 => 5,
        SlateStateV4::Invoice3 => 6,
    }
}

fn state_from_byte(b: u8) -> SlateStateV4 {
    match b {
        1 => SlateStateV4::Standard1,
        2 => SlateStateV4::Standard2,
        3 => SlateStateV4::Standard3,
        4 => SlateStateV4::Invoice1,
        5 => SlateStateV4::Invoice2,
        6 => SlateStateV4::Invoice3,
        _ => SlateStateV4::Unknown,
    }
}

fn uuid_to_bytes(id: &str) -> Result<[u8; 16], String> {
    let parsed = uuid::Uuid::parse_str(id).map_err(|e| format!("invalid slate UUID: {e}"))?;
    Ok(*parsed.as_bytes())
}

fn uuid_from_bytes(bytes: [u8; 16]) -> String {
    uuid::Uuid::from_bytes(bytes).to_string()
}

fn write_opt_fields(w: &mut W, s: &SlateV4) {
    // status byte: 0 0 0 t f f a n
    let mut status: u8 = 0;
    if s.num_parts != 2 {
        status |= 0x01;
    }
    if s.amt > 0 {
        status |= 0x02;
    }
    if s.fee > 0 {
        status |= 0x04;
    }
    if s.feat > 0 {
        status |= 0x08;
    }
    if s.ttl > 0 {
        status |= 0x10;
    }
    w.u8(status);
    if status & 0x01 > 0 {
        w.u8(s.num_parts);
    }
    if status & 0x02 > 0 {
        w.u64(s.amt);
    }
    if status & 0x04 > 0 {
        // FeeFields is a packed u64. Our SlateV4 stores raw fee; with
        // shift=0 (the only supported value for v0.3) the packed
        // representation equals the raw fee as u64.
        w.u64(s.fee);
    }
    if status & 0x08 > 0 {
        w.u8(s.feat);
    }
    if status & 0x10 > 0 {
        w.u64(s.ttl);
    }
}

fn read_opt_fields(r: &mut R) -> Result<(u8, u64, u64, u8, u64), String> {
    let status = r.u8()?;
    let num_parts = if status & 0x01 > 0 { r.u8()? } else { 2 };
    let amt = if status & 0x02 > 0 { r.u64()? } else { 0 };
    let fee = if status & 0x04 > 0 { r.u64()? } else { 0 };
    let feat = if status & 0x08 > 0 { r.u8()? } else { 0 };
    let ttl = if status & 0x10 > 0 { r.u64()? } else { 0 };
    Ok((num_parts, amt, fee, feat, ttl))
}

fn write_sigs(w: &mut W, sigs: &[ParticipantDataV4]) -> Result<(), String> {
    // The V4 wire format has exactly one byte for this count, so a longer
    // list is unencodable. Refusing beats truncating: a wrapped count would
    // still be a well-formed slate, just one describing a different
    // transaction than the one we hold.
    let count = u8::try_from(sigs.len()).map_err(|_| {
        format!("slate bin: {} participants exceeds the u8 count field", sigs.len())
    })?;
    w.u8(count);
    for s in sigs {
        if s.part.is_some() {
            w.u8(1);
        } else {
            w.u8(0);
        }
        // Compressed PublicKey is 33 bytes.
        w.bytes(&s.xs);
        w.bytes(&s.nonce);
        if let Some(p) = &s.part {
            // Signature is 64 bytes.
            w.bytes(p);
        }
    }
    Ok(())
}

fn read_sigs(r: &mut R) -> Result<Vec<ParticipantDataV4>, String> {
    let n = r.u8()?;
    let mut out = Vec::with_capacity(n as usize);
    for _ in 0..n {
        let has_partial = r.u8()?;
        let xs: [u8; 33] = r.fixed()?;
        let nonce: [u8; 33] = r.fixed()?;
        let part = if has_partial == 1 {
            Some(r.fixed::<64>()?)
        } else {
            None
        };
        out.push(ParticipantDataV4 { xs, nonce, part });
    }
    Ok(out)
}

fn write_coms(w: &mut W, coms: &[CommitsV4]) -> Result<(), String> {
    // Same reasoning as write_sigs: this count is 16 bits wide on the wire,
    // so an over-long list must be rejected rather than silently wrapped.
    let count = u16::try_from(coms.len()).map_err(|_| {
        format!("slate bin: {} commitments exceeds the u16 count field", coms.len())
    })?;
    w.u16(count);
    for o in coms {
        if o.p.is_some() {
            w.u8(1); // output (with proof)
        } else {
            w.u8(0); // input ref
        }
        // OutputFeatures: 0=Plain, 1=Coinbase. 1-byte feature code.
        w.u8(o.f);
        // Pedersen commitment: 33 bytes.
        w.bytes(&o.c);
        if let Some(p) = &o.p {
            // RangeProof: length-prefixed (u64 BE length per grin_ser).
            w.u64(p.len() as u64);
            w.bytes(p);
        }
    }
    Ok(())
}

fn read_coms(r: &mut R) -> Result<Vec<CommitsV4>, String> {
    let n = r.u16()? as usize;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let is_output = r.u8()?;
        let f = r.u8()?;
        let c: [u8; 33] = r.fixed()?;
        let p = if is_output == 1 {
            // This length is whatever the transaction counterparty put in
            // their slatepack. On wasm32 `as usize` would truncate it to 32
            // bits, so a crafted 2^32 + k would shrink to k, sail through
            // the reader's bounds check, and silently desynchronise the
            // parse of every commitment that follows.
            let plen_wire = r.u64()?;
            let plen = usize::try_from(plen_wire).map_err(|_| {
                format!("slate bin: rangeproof length {plen_wire} does not fit in usize")
            })?;
            Some(r.bytes(plen)?.to_vec())
        } else {
            None
        };
        out.push(CommitsV4 { f, c, p });
    }
    Ok(out)
}

fn write_proof(w: &mut W, p: &PaymentInfoV4) {
    w.bytes(&p.saddr);
    w.bytes(&p.raddr);
    match &p.rsig {
        Some(s) => {
            w.u8(1);
            w.bytes(s);
        }
        None => w.u8(0),
    }
}

fn read_proof(r: &mut R) -> Result<PaymentInfoV4, String> {
    let saddr: [u8; 32] = r.fixed()?;
    let raddr: [u8; 32] = r.fixed()?;
    let rsig = match r.u8()? {
        1 => Some(r.fixed::<64>()?),
        _ => None,
    };
    Ok(PaymentInfoV4 { saddr, raddr, rsig })
}

fn write_opt_structs(
    w: &mut W,
    coms: &Option<Vec<CommitsV4>>,
    proof: &Option<PaymentInfoV4>,
) -> Result<(), String> {
    let mut status: u8 = 0;
    if coms.is_some() {
        status |= 0x01;
    }
    if proof.is_some() {
        status |= 0x02;
    }
    w.u8(status);
    if let Some(c) = coms {
        write_coms(w, c)?;
    }
    if let Some(p) = proof {
        write_proof(w, p);
    }
    Ok(())
}

fn read_opt_structs(r: &mut R) -> Result<(Option<Vec<CommitsV4>>, Option<PaymentInfoV4>), String> {
    let status = r.u8()?;
    let coms = if status & 0x01 > 0 {
        Some(read_coms(r)?)
    } else {
        None
    };
    let proof = if status & 0x02 > 0 {
        Some(read_proof(r)?)
    } else {
        None
    };
    Ok((coms, proof))
}

// ============================================================================
// Public API
// ============================================================================

/// Serialize a SlateV4 to grin's compact binary format. Output is what
/// goes inside a slatepack payload for external-wallet interop.
pub fn serialize_slate_v4_bin(slate: &SlateV4) -> Result<Vec<u8>, String> {
    let mut w = W::new();
    w.u16(slate.ver.version);
    w.u16(slate.ver.block_header_version);
    w.bytes(&uuid_to_bytes(&slate.id)?);
    w.u8(state_byte(slate.sta));
    w.bytes(&slate.off);
    write_opt_fields(&mut w, slate);
    write_sigs(&mut w, &slate.sigs)?;
    write_opt_structs(&mut w, &slate.coms, &slate.proof)?;
    // For HeightLocked (feat=2) or NRD (feat=3), append the
    // lock_hgt / relative_height u64 (both stored in feat_args.lock_hgt).
    if slate.feat == 2 || slate.feat == 3 {
        let lock_hgt = slate
            .feat_args
            .as_ref()
            .map_or(0, |a| a.lock_hgt);
        w.u64(lock_hgt);
    }
    Ok(w.into_inner())
}

/// Parse a slate from grin's compact binary format. Inverse of
/// `serialize_slate_v4_bin`.
pub fn deserialize_slate_v4_bin(bytes: &[u8]) -> Result<SlateV4, String> {
    let mut r = R::new(bytes);
    let version = r.u16()?;
    let block_header_version = r.u16()?;
    let id_bytes: [u8; 16] = r.fixed()?;
    let sta = state_from_byte(r.u8()?);
    let off: [u8; 32] = r.fixed()?;
    let (num_parts, amt, fee, feat, ttl) = read_opt_fields(&mut r)?;
    let sigs = read_sigs(&mut r)?;
    let (coms, proof) = read_opt_structs(&mut r)?;
    let feat_args = if feat == 2 || feat == 3 {
        let lock_hgt = r.u64()?;
        Some(KernelFeaturesArgsV4 { lock_hgt })
    } else {
        None
    };
    Ok(SlateV4 {
        ver: VersionCompatInfoV4 {
            version,
            block_header_version,
        },
        id: uuid_from_bytes(id_bytes),
        sta,
        off,
        num_parts,
        amt,
        fee,
        feat,
        ttl,
        sigs,
        coms,
        proof,
        feat_args,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        kernel::KernelFeatures, sender_init_s1, SenderInitParams,
    };

    fn build_test_s1_slate() -> SlateV4 {
        let params = SenderInitParams {
            amount: 1_000_000_000,
            fee: 8_000_000,
            kernel_features: KernelFeatures::Plain { fee: 8_000_000 },
            sender_blind_excess: [0x42u8; 32],
            kernel_offset: [0u8; 32],
            kernel_nonce: [0x77u8; 32],
        };
        sender_init_s1(&params).unwrap().slate
    }

    #[test]
    fn round_trip_minimal_s1_slate() {
        let slate = build_test_s1_slate();
        let bin = serialize_slate_v4_bin(&slate).unwrap();
        let back = deserialize_slate_v4_bin(&bin).unwrap();
        assert_eq!(slate, back);
    }

    /// The 16 bytes standing in for a rangeproof body in the tests below.
    const PROOF_BODY: [u8; 16] = [0xBB; 16];

    /// Hand-build a `coms` section holding one output whose rangeproof body
    /// is [`PROOF_BODY`] but whose length prefix is `plen`. Only the prefix
    /// differs between the honest and the hostile case below.
    fn coms_bytes(plen: u64) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&1u16.to_be_bytes()); // one entry
        bytes.push(1); // is_output = 1, so a rangeproof follows
        bytes.push(0); // OutputFeatures::Plain
        bytes.extend_from_slice(&[0xAA; 33]); // Pedersen commitment
        bytes.extend_from_slice(&plen.to_be_bytes());
        bytes.extend_from_slice(&PROOF_BODY);
        bytes
    }

    #[test]
    fn rangeproof_length_that_overflows_32_bits_is_rejected() {
        // Control: with an honest prefix these exact bytes parse cleanly.
        let coms = read_coms(&mut R::new(&coms_bytes(16))).unwrap();
        assert_eq!(coms.len(), 1);
        assert_eq!(coms[0].p.as_deref(), Some(&PROOF_BODY[..]));

        // Hostile: 2^32 + 16 truncates to 16 when cast to a 32-bit usize,
        // i.e. to the control case above. Under the old `as usize` the
        // wallet would have accepted this on wasm32: the bounds check would
        // pass, 16 bytes would be consumed, and everything after this
        // commitment would be parsed from the wrong offset, so the wallet
        // could act on a slate its counterparty never sent.
        let hostile = (1u64 << 32) + 16;
        let err = read_coms(&mut R::new(&coms_bytes(hostile))).unwrap_err();

        // On a 32-bit target the length conversion is what rejects it; on a
        // 64-bit host the length converts fine and the bounds check rejects
        // it instead. Both are refusals, which is the invariant that
        // matters, but only the first proves nothing was truncated.
        if usize::BITS < 64 {
            assert!(
                err.contains("does not fit in usize"),
                "expected a length-conversion refusal, got: {err}"
            );
        }
    }

    #[test]
    fn binary_size_is_bounded() {
        // Sanity: a 1-input, 1-output S1 slate shouldn't blow up.
        // ~50 bytes header + 70 bytes sigs ≤ 200 bytes total for a
        // freshly-init S1 without coms/proof. Catches accidental
        // bloat (e.g. writing length prefixes where they're not
        // needed).
        let slate = build_test_s1_slate();
        let bin = serialize_slate_v4_bin(&slate).unwrap();
        assert!(
            bin.len() < 200,
            "freshly-initialized S1 slate should be < 200 bytes, got {}",
            bin.len()
        );
    }
}
