# Fovet SDK — Native unit tests (PC / gcc)
# Usage:
#   make           → build all + run all
#   make build     → build only
#   make clean     → remove artifacts

CC      = gcc
CFLAGS  = -std=c99 -Wall -Wextra -Wpedantic -O2 \
          -I../include \
          -DFOVET_NATIVE_TEST
LDFLAGS = -lm

SRC_DIR         = ..
FORGE_MODELS    = ../../automl-pipeline/models/demo_zscore

TESTS = test_zscore test_drift test_forge_integration test_mad

.PHONY: all build run clean $(addprefix run_,$(TESTS))

all: build run

build: $(TESTS)

# --- test_zscore ---
test_zscore: $(SRC_DIR)/src/zscore.c test_zscore.c
	$(CC) $(CFLAGS) -o $@ $^ $(LDFLAGS)

# --- test_drift ---
test_drift: $(SRC_DIR)/src/zscore.c $(SRC_DIR)/src/drift.c test_drift.c
	$(CC) $(CFLAGS) -o $@ $^ $(LDFLAGS)

# --- test_forge_integration ---
test_forge_integration: $(SRC_DIR)/src/zscore.c test_forge_integration.c
	$(CC) $(CFLAGS) -I$(FORGE_MODELS) -o $@ $^ $(LDFLAGS)

# --- run all ---
run: $(addprefix run_,$(TESTS))

run_test_zscore: test_zscore
	@echo "--- test_zscore ---" && ./test_zscore

run_test_drift: test_drift
	@echo "--- test_drift ---" && ./test_drift

run_test_forge_integration: test_forge_integration
	@echo "--- test_forge_integration ---" && ./test_forge_integration

# --- test_mad ---
test_mad: $(SRC_DIR)/src/mad.c test_mad.c
	$(CC) $(CFLAGS) -o $@ $^ $(LDFLAGS)

run_test_mad: test_mad
	@echo "--- test_mad ---" && ./test_mad

clean:
	rm -f $(TESTS) *.o
