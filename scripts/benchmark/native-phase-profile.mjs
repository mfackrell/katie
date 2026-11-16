// The trusted native child starts a fresh thread for each phase. Its mandatory
// prompt requires reading the owner request and inspecting local source before
// the final response. One tool request plus a response consuming its result is
// the minimum for this profile, not a measured estimate or completion guarantee.
// This does not describe retained SDK turns or DO completion/assessment calls.
export const FRESH_NATIVE_PHASE_PROFILE='fresh-native-inspection-v1';
export const freshNativePhaseWork=Object.freeze({nativePhaseProfile:FRESH_NATIVE_PHASE_PROFILE,nativeMinimumCalls:2});
