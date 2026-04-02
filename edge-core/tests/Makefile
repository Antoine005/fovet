# Ardent SDK — Pulse — Native unit tests (PC / gcc)
# Usage:
#   make           → build all + run all
#   make build     → build only
#   make clean     → remove artifacts

# On Windows/MSYS2: ensure mingw64/bin is in PATH so DLL deps are found
# export PATH="/c/msys64/mingw64/bin:$PATH" before running make
CC      = gcc
CFLAGS  = -std=c99 -Wall -Wextra -Wpedantic -O2 \
          -I../include \
          -DARD_NATIVE_TEST
LDFLAGS = -lm

SRC_DIR         = ..
FORGE_MODELS    = ../../automl-pipeline/models/demo_zscore

TESTS = test_zscore test_drift test_forge_integration test_mad \
        test_biosignal_hal test_mpu6050_hal test_pti_profile test_max30102_hal test_fatigue_profile test_dht22_hal test_temp_profile \
        test_i2c_hal test_mpu6050

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

# --- test_max30102_hal ---
test_max30102_hal: $(SRC_DIR)/src/biosignal_hal.c $(SRC_DIR)/src/max30102_hal.c test_max30102_hal.c
	$(CC) $(CFLAGS) -o $@ $^ $(LDFLAGS)

run_test_max30102_hal: test_max30102_hal
	@echo "--- test_max30102_hal ---" && ./test_max30102_hal

# --- test_fatigue_profile ---
test_fatigue_profile: $(SRC_DIR)/src/biosignal_hal.c $(SRC_DIR)/src/max30102_hal.c $(SRC_DIR)/src/profiles/fatigue_profile.c test_fatigue_profile.c
	$(CC) $(CFLAGS) -o $@ $^ $(LDFLAGS)

run_test_fatigue_profile: test_fatigue_profile
	@echo "--- test_fatigue_profile ---" && ./test_fatigue_profile

# --- test_dht22_hal ---
test_dht22_hal: $(SRC_DIR)/src/biosignal_hal.c $(SRC_DIR)/src/dht22_hal.c test_dht22_hal.c
	$(CC) $(CFLAGS) -o $@ $^ $(LDFLAGS)

run_test_dht22_hal: test_dht22_hal
	@echo "--- test_dht22_hal ---" && ./test_dht22_hal

# --- test_temp_profile ---
test_temp_profile: $(SRC_DIR)/src/biosignal_hal.c $(SRC_DIR)/src/profiles/temp_profile.c test_temp_profile.c
	$(CC) $(CFLAGS) -o $@ $^ $(LDFLAGS)

run_test_temp_profile: test_temp_profile
	@echo "--- test_temp_profile ---" && ./test_temp_profile

# --- test_mad ---
test_mad: $(SRC_DIR)/src/mad.c test_mad.c
	$(CC) $(CFLAGS) -o $@ $^ $(LDFLAGS)

run_test_mad: test_mad
	@echo "--- test_mad ---" && ./test_mad

# --- test_i2c_hal ---
test_i2c_hal: test_i2c_hal.c
	$(CC) $(CFLAGS) -o $@ $^

run_test_i2c_hal: test_i2c_hal
	@echo "--- test_i2c_hal ---" && ./test_i2c_hal

# --- test_mpu6050 ---
test_mpu6050: test_mpu6050.c $(SRC_DIR)/src/drivers/mpu6050.c
	$(CC) $(CFLAGS) -o $@ $^ $(LDFLAGS)

run_test_mpu6050: test_mpu6050
	@echo "--- test_mpu6050 ---" && ./test_mpu6050

clean:
	rm -f $(TESTS) *.o
