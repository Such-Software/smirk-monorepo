//! Bounded decoder for BasicSwap's protobuf wire subset.
use super::{Error, Result, MAX_PAYLOAD_BYTES};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
enum Value {
    Integer(u64),
    Bytes(Vec<u8>),
}

/// Raw message fields. Decoding does not establish protocol or offer validity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireMessage {
    kind: u8,
    fields: BTreeMap<u64, Value>,
}

fn field_type(kind: u8, field: u64) -> Result<u8> {
    match (kind, field) {
        (1, 1..=10 | 15..=18 | 20) | (14, 1 | 3) => Ok(0),
        (1, 11..=14 | 19 | 21) | (11, 1 | 2) | (14, 2 | 4) => Ok(2),
        _ => Err(Error("unsupported message kind or field")),
    }
}
fn varint(input: &[u8], offset: &mut usize) -> Result<u64> {
    let mut value = 0;
    for index in 0..10 {
        let byte = *input.get(*offset).ok_or(Error("truncated varint"))?;
        *offset += 1;
        if index == 9 && byte > 1 {
            return Err(Error("varint overflow"));
        }
        value |= u64::from(byte & 127) << (7 * index);
        if byte & 128 == 0 {
            if index > 0 && byte == 0 {
                return Err(Error("noncanonical varint"));
            }
            return Ok(value);
        }
    }
    Err(Error("varint overflow"))
}
fn put_varint(mut value: u64, out: &mut Vec<u8>) {
    while value >= 128 {
        out.push(u8::try_from(value & 127).expect("seven bits") | 128);
        value >>= 7;
    }
    out.push(u8::try_from(value).expect("seven bits"));
}
impl WireMessage {
    pub fn decode(input: &[u8]) -> Result<Self> {
        if input.len() > MAX_PAYLOAD_BYTES {
            return Err(Error("payload exceeds size limit"));
        }
        let kind = *input.first().ok_or(Error("missing message kind"))?;
        if !matches!(kind, 1 | 11 | 14) {
            return Err(Error("unsupported message kind"));
        }
        let mut fields = BTreeMap::new();
        let mut offset = 1;
        while offset < input.len() {
            let tag = varint(input, &mut offset)?;
            let field = tag >> 3;
            let wire_type = field_type(kind, field)?;
            if tag & 7 != u64::from(wire_type) {
                return Err(Error("wrong field wire type"));
            }
            let value = if wire_type == 0 {
                Value::Integer(varint(input, &mut offset)?)
            } else {
                let len = usize::try_from(varint(input, &mut offset)?)
                    .map_err(|_| Error("field length overflow"))?;
                let end = offset
                    .checked_add(len)
                    .ok_or(Error("field length overflow"))?;
                let bytes = input.get(offset..end).ok_or(Error("truncated field"))?;
                offset = end;
                Value::Bytes(bytes.to_vec())
            };
            if fields.insert(field, value).is_some() {
                return Err(Error("duplicate field"));
            }
        }
        let msg = Self { kind, fields };
        if kind == 1 {
            for field in [11, 12, 21] {
                msg.string(field)?;
            }
            for field in [17, 18] {
                if msg.integer(field)? > 1 {
                    return Err(Error("invalid boolean"));
                }
            }
        }
        Ok(msg)
    }
    /// Canonical field order, with default-valued fields omitted as in BasicSwap.
    pub fn encode(&self) -> Vec<u8> {
        let mut out = vec![self.kind];
        for (&field, value) in &self.fields {
            match value {
                Value::Integer(0) => {}
                Value::Integer(n) => {
                    put_varint(field << 3, &mut out);
                    put_varint(*n, &mut out);
                }
                Value::Bytes(b) if b.is_empty() => {}
                Value::Bytes(b) => {
                    put_varint((field << 3) | 2, &mut out);
                    put_varint(
                        u64::try_from(b.len()).expect("bounded field length"),
                        &mut out,
                    );
                    out.extend_from_slice(b);
                }
            }
        }
        out
    }
    pub fn kind(&self) -> u8 {
        self.kind
    }
    pub fn integer(&self, field: u64) -> Result<u64> {
        if field_type(self.kind, field)? != 0 {
            return Err(Error("field is not an integer"));
        }
        match self.fields.get(&field) {
            Some(Value::Integer(n)) => Ok(*n),
            None => Ok(0),
            _ => Err(Error("field is not an integer")),
        }
    }
    pub fn bytes(&self, field: u64) -> Result<&[u8]> {
        if field_type(self.kind, field)? != 2 {
            return Err(Error("field is not bytes"));
        }
        match self.fields.get(&field) {
            Some(Value::Bytes(b)) => Ok(b),
            None => Ok(&[]),
            _ => Err(Error("field is not bytes")),
        }
    }
    pub fn string(&self, field: u64) -> Result<&str> {
        std::str::from_utf8(self.bytes(field)?).map_err(|_| Error("invalid field UTF-8"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_ambiguous_and_truncated_fields() {
        for input in [
            vec![],
            vec![2],
            vec![1, 8, 128],
            vec![1, 8, 128, 0],
            vec![1, 8, 7, 8, 6],
            vec![1, 170, 1, 4, b'a'],
            vec![1, 10, 0],
            vec![1, 136, 1, 2],
            vec![1, 170, 1, 1, 255],
            vec![14, 8, 255, 255, 255, 255, 255, 255, 255, 255, 255, 2],
        ] {
            assert!(WireMessage::decode(&input).is_err());
        }
    }
    #[test]
    fn preserves_u64_and_normalizes_default_fields() {
        let input = [
            1, 8, 7, 32, 255, 255, 255, 255, 255, 255, 255, 255, 255, 1, 136, 1, 0,
        ];
        let msg = WireMessage::decode(&input).unwrap();
        assert_eq!(msg.integer(4).unwrap(), u64::MAX);
        assert_eq!(
            WireMessage::decode(&msg.encode())
                .unwrap()
                .integer(4)
                .unwrap(),
            u64::MAX
        );
        assert!(msg.encode().len() < input.len());
    }
    #[test]
    fn bounds_all_input_lengths() {
        assert!(WireMessage::decode(&vec![0; MAX_PAYLOAD_BYTES + 1]).is_err());
        for len in 1..12 {
            let mut input = vec![1, 170, 1];
            input.extend(vec![255; len]);
            assert!(WireMessage::decode(&input).is_err());
        }
    }
}
