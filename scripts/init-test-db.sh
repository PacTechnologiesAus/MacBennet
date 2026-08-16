#!/bin/sh
# Runs once when the Postgres volume is first initialised.
# Creates the separate database used by the integration and e2e test suites so
# that running tests can never touch development data.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE DATABASE ${MAC_TEST_DB:-mac_bennett_test} OWNER ${POSTGRES_USER};
EOSQL
