/* Test-only wall clock for the fixed, already-approved November 16 cutoff.
 * Loaded only into disposable test processes. CLOCK_MONOTONIC is unchanged.
 * Production SQL, application sources and authorization guards run unmodified.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdlib.h>
#include <time.h>
#include <sys/time.h>
static long long offset(void) {
 const char *s=getenv("KATIE_TEST_REALTIME_OFFSET_NS");
 return s?strtoll(s,NULL,10):0;
}
int clock_gettime(clockid_t clock, struct timespec *value) {
 static int (*real_clock_gettime)(clockid_t,struct timespec *);
 if(!real_clock_gettime)real_clock_gettime=dlsym(RTLD_NEXT,"clock_gettime");
 int result=real_clock_gettime(clock,value);
 if(!result&&(clock==CLOCK_REALTIME||clock==CLOCK_REALTIME_COARSE)) {
  long long ns=(long long)value->tv_nsec+offset();
  value->tv_sec+=ns/1000000000LL;value->tv_nsec=ns%1000000000LL;
  if(value->tv_nsec<0){value->tv_nsec+=1000000000L;value->tv_sec--;}
 }
 return result;
}
int gettimeofday(struct timeval *value, void *zone) {
 static int (*real_gettimeofday)(struct timeval *,void *);
 if(!real_gettimeofday)real_gettimeofday=dlsym(RTLD_NEXT,"gettimeofday");
 int result=real_gettimeofday(value,zone);
 if(!result){
  long long us=(long long)value->tv_usec+offset()/1000LL;
  value->tv_sec+=us/1000000LL;value->tv_usec=us%1000000LL;
  if(value->tv_usec<0){value->tv_usec+=1000000L;value->tv_sec--;}
 }
 return result;
}
time_t time(time_t *out) {
 struct timespec value;clock_gettime(CLOCK_REALTIME,&value);
 if(out)*out=value.tv_sec;return value.tv_sec;
}
