-- 0003_collision_clock — review fixes of the 0.2.0 upgrade (CHANGELOG [0.2.0]).
--
-- Forward-only like 0001 and 0002: never edit once applied, add 0004_<change>.sql instead.

-- GET /safety/encounters?active=… measures its window on the collision detector's event clock:
-- the newest collision_evaluated_at (AIS time of the newest position the detector evaluated),
-- read as max() through this index instead of a scan of every vessel's state.
CREATE INDEX vessel_state_collision_evaluated_idx ON vessel_state (collision_evaluated_at DESC)
  WHERE collision_evaluated_at IS NOT NULL;
