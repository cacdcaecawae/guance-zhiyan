#!/bin/sh
set -eu
# The workload and sidecar share a network namespace. Block the untrusted uid
# before upstream's loopback allow rule; root-owned SDK/control processes still work.
# A separate table survives upstream egress policy updates. Failure prevents startup.
nft -f - <<'RULES'
add table inet gczy_control
add chain inet gczy_control output { type filter hook output priority -200; policy accept; }
flush chain inet gczy_control output
add rule inet gczy_control output meta skuid 1000 tcp dport { 44772, 18080 } reject with tcp reset
RULES
exec /opt/opensandbox-egress/supervisor \
  --pre-start=/opt/opensandbox-egress/cleanup.sh \
  --name=egress --grace-period=20s -- /opt/opensandbox-egress/egress "$@"
