# Fovet SDK — Native unit tests (PC / gcc)
# Usage:
#   make           → build all + run all
#   make build     → build only
#   make clean     → remove artifacts

# On Windows/MSYS2: ensure mingw64/bin is in PATH so DLL deps are found
# export PATH="/c/msys64/mingw64/bin:$PATH" before running make
CC      = gcc
CFLAGS  = -std=c99 -Wall -Wextra -Wpedantic -O2 \
          -I../include \
          -DFOVET_NATIVE_TEST
LDFLAGS = -lm

SRC_DIR         = ..
FORGE_MODELS    = ../../automl-pipeline/models/demo_zscore

TESTS = test_zscore test_drift test_forge_integration test_biosignal_hal test_mpu6050_hal test_pti_profile

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

# --- test_biosignal_hal ---
test_biosignal_hal: $(SRC_DIR)/src/biosignal_hal.c test_biosignal_hal.c
	$(CC) $(CFLAGS) -o $@ $^ $(LDFLAGS)

# --- test_mpu6050_hal ---
test_mpu6050_hal: $(SRC_DIR)/src/biosignal_hal.c $(SRC_DIR)/src/mpu6050_hal.c test_mpu6050_hal.c
	$(CC) $(CFLAGS) -o $@ $^ $(LDFLAGS)

# --- run all ---
run: $(addprefix run_,$(TESTS))

run_test_zscore: test_zscore
	@echo "--- test_zscore ---" && ./test_zscore

run_test_drift: test_drift
	@echo "--- test_drift ---" && ./test_drift

run_test_forge_integration: test_forge_integration
	@echo "--- test_forge_integration ---" && ./test_forge_integration

run_test_biosignal_hal: test_biosignal_hal
	@echo "--- test_biosignal_hal ---" && ./test_biosignal_hal

run_test_mpu6050_hal: test_mpu6050_hal
	@echo "--- test_mpu6050_hal ---" && ./test_mpu6050_hal

# --- test_pti_profile ---
test_pti_profile: $(SRC_DIR)/src/biosignal_hal.c $(SRC_DIR)/src/profiles/pti_profile.c test_pti_profile.c
	$(CC) $(CFLAGS) -o $@ $^ $(LDFLAGS)

run_test_pti_profile: test_pti_profile
	@echo "--- test_pti_profile ---" && ./test_pti_profile

clean:
	rm -f $(TESTS) *.o
