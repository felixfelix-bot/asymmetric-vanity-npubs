cmake_minimum_required(VERSION 3.18)

# ─── Project ────────────────────────────────────────────────────────────────
project(cuda_vanity_offset
    VERSION 0.1.0
    DESCRIPTION "GPU CUDA kernel for Nostr vanity NPUB offset grinding (P + d·G)"
    LANGUAGES CXX CUDA)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CUDA_STANDARD 17)

# ─── CUDA architecture detection ────────────────────────────────────────────
# Default to a broad range of architectures; override with -DCMAKE_CUDA_ARCHITECTURES
if(NOT DEFINED CMAKE_CUDA_ARCHITECTURES)
    set(CMAKE_CUDA_ARCHITECTURES 60 70 75 80 86 89 90)
endif()

# ─── Compiler flags ──────────────────────────────────────────────────────────
if(CMAKE_BUILD_TYPE STREQUAL "Release" OR NOT CMAKE_BUILD_TYPE)
    set(CMAKE_CUDA_FLAGS_RELEASE "-O2 --use_fast_math")
    set(CMAKE_CXX_FLAGS_RELEASE "-O2")
endif()

# ─── Include directories ─────────────────────────────────────────────────────
include_directories(${CMAKE_CURRENT_SOURCE_DIR}/include)

# ─── Sources ─────────────────────────────────────────────────────────────────
set(CUDA_SOURCES
    src/offset_grind.cu
    src/main.cu
)

set(CUDA_HEADERS
    include/secp256k1.cuh
    include/vanity.cuh
)

# ─── Executable ──────────────────────────────────────────────────────────────
add_executable(cuda_vanity_offset ${CUDA_SOURCES} ${CUDA_HEADERS})

# ─── Install ─────────────────────────────────────────────────────────────────
install(TARGETS cuda_vanity_offset
    RUNTIME DESTINATION bin)

# ─── Tests (optional) ───────────────────────────────────────────────────────
option(BUILD_TESTS "Build CUDA offset grinding tests" OFF)
if(BUILD_TESTS)
    enable_testing()
    add_subdirectory(tests)
endif()