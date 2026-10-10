use super::{Advertisement, Connect, Error, Result};

/// Public identifiers of a pending route. The caller owns separate messaging
/// and ephemeral route keys and must persist the pending exchange before send.
#[derive(Debug)]
pub struct PendingRoute {
    offer_id: [u8; 28],
    local_sender: [u8; 33],
    remote_sender: [u8; 33],
    local_key: [u8; 32],
    expires: u64,
}
#[derive(Debug)]
pub struct Route {
    offer_id: [u8; 28],
    local_sender: [u8; 33],
    remote_sender: [u8; 33],
    local_key: [u8; 32],
    remote_key: [u8; 32],
    request_sent: u64,
    expires: u64,
}
impl PendingRoute {
    /// Only a request for this maker and live offer can establish a pending route.
    pub fn from_request(req: &Connect, offer: &Advertisement, now: u64) -> Result<Self> {
        if req.requested_key.is_some()
            || req.offer_id != offer.id
            || req.recipient != offer.sender
            || req.expires <= now
            || offer.expires <= now
        {
            return Err(Error("request does not match live offer"));
        }
        Ok(Self {
            offer_id: req.offer_id,
            local_sender: req.sender,
            remote_sender: req.recipient,
            local_key: req.route_key,
            expires: req.expires.min(offer.expires),
        })
    }
    /// A previous route's ACK cannot activate this pending exchange.
    pub fn accept(&self, ack: &Connect, now: u64) -> Result<Route> {
        if ack.offer_id != self.offer_id
            || ack.sender != self.remote_sender
            || ack.recipient != self.local_sender
            || ack.requested_key != Some(self.local_key)
            || ack.expires <= now
            || self.expires <= now
        {
            return Err(Error("ACK does not match pending route"));
        }
        Ok(Route {
            offer_id: self.offer_id,
            local_sender: self.local_sender,
            remote_sender: self.remote_sender,
            local_key: self.local_key,
            remote_key: ack.route_key,
            request_sent: 0,
            expires: self.expires,
        })
    }
}
impl Route {
    pub fn accept_request(
        req: &Connect,
        offer: &Advertisement,
        local_key: [u8; 32],
        now: u64,
    ) -> Result<Self> {
        PendingRoute::from_request(req, offer, now)?;
        k256::schnorr::VerifyingKey::from_bytes(&local_key)
            .map_err(|_| Error("invalid local route key"))?;
        Ok(Self {
            offer_id: req.offer_id,
            local_sender: req.recipient,
            remote_sender: req.sender,
            local_key,
            remote_key: req.route_key,
            request_sent: req.sent,
            expires: offer.expires.min(req.expires),
        })
    }
    /// Repeated requests reuse the key. Replacement requires a later timestamp
    /// from the same authenticated messaging identity and the same offer.
    pub fn update_request(&mut self, req: &Connect, now: u64) -> Result<()> {
        if req.offer_id != self.offer_id
            || req.sender != self.remote_sender
            || req.recipient != self.local_sender
            || req.requested_key.is_some()
            || self.expires <= now
            || req.expires <= now
        {
            return Err(Error("request does not match active route"));
        }
        if req.route_key != self.remote_key && req.sent <= self.request_sent {
            return Err(Error("stale route key replacement"));
        }
        self.remote_key = req.route_key;
        self.request_sent = self.request_sent.max(req.sent);
        Ok(())
    }
    pub fn local_key(&self) -> &[u8; 32] {
        &self.local_key
    }
    pub fn remote_key(&self) -> &[u8; 32] {
        &self.remote_key
    }
}
