# Fovet SDK — Native unit tests (PC / gcc)
# Usage:
#   make           → build + run
#   make build     → build only
#   make clean     → remove artifacts

CC      = gcc
CFLAGS  = -std=c99 -Wall -Wextra -Wpedantic -O2 \
          -I../include \
          -DFOVET_NATIVE_TEST
LDFLAGS = -lm

SRC_DIR = ..
SRCS    = $(SRC_DIR)/src/zscore.c \
          test_zscore.c
OUT     = test_zscore

.PHONY: all build run clean

all: build run

build: $(OUT)

$(OUT): $(SRCS)
	$(CC) $(CFLAGS) -o $@ $^ $(LDFLAGS)

run: $(OUT)
	./$(OUT)

clean:
	rm -f $(OUT) *.o
