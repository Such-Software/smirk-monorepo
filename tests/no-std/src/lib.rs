#![no_std]

pub use monero_epee;

#[cfg(feature = "alloc")]
pub mod alloc {
  pub use monero_wallet;
}
