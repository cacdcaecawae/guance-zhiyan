FROM opensandbox/egress:v1.1.7
COPY server/sandbox/egress-entrypoint.sh /opt/gczy-egress-entrypoint.sh
ENTRYPOINT ["sh", "/opt/gczy-egress-entrypoint.sh"]
