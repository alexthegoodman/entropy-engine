use std::collections::BTreeSet;
use std::time::Duration;

use cucumber::{World as _, given, then, when};
use entropy_engine::p2p::scheduler::{Limits, Plan, ScheduleMode, Scheduler};

#[derive(Default, cucumber::World)]
struct Swarm {
    scheduler: Option<Scheduler>,
    plan: Plan,
    fetched: BTreeSet<u32>,
}

impl std::fmt::Debug for Swarm {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Swarm")
    }
}

fn limits() -> Limits {
    Limits {
        per_peer: 2,
        total: 3,
        request_timeout: Duration::from_secs(1),
    }
}

#[given("a swarm with complementary piece maps")]
fn swarm(w: &mut Swarm) {
    let mut s = Scheduler::new(vec![false; 6], ScheduleMode::RarestFirst, limits());
    s.set_peer("a".into(), [0, 1, 2, 4]);
    s.set_peer("b".into(), [0, 1, 3, 5]);
    s.set_peer("c".into(), [0, 2, 4, 5]);
    w.scheduler = Some(s);
}

#[given("a peer advertises invalid and unavailable pieces")]
fn invalid(w: &mut Swarm) {
    let mut s = Scheduler::new(
        vec![true, false, false],
        ScheduleMode::RarestFirst,
        limits(),
    );
    s.set_peer("a".into(), [0, 1, 3, u32::MAX]);
    w.scheduler = Some(s);
}

#[when("I schedule a bulk download")]
#[when("I fill the request pipeline")]
fn poll(w: &mut Swarm) {
    w.plan = w.scheduler.as_mut().unwrap().poll(Duration::ZERO);
}

#[then("piece 3 is requested first")]
fn rarest(w: &mut Swarm) {
    assert_eq!(w.plan.want[0].index, 3);
}

#[then("only the valid available piece is requested")]
fn valid(w: &mut Swarm) {
    assert_eq!(w.plan.want.iter().map(|r| r.index).collect::<Vec<_>>(), [1]);
}

#[then("the pipeline stays within both caps")]
fn caps(w: &mut Swarm) {
    assert_eq!(w.plan.want.len(), 3);
    for p in ["a", "b", "c"] {
        assert!(w.plan.want.iter().filter(|r| r.peer.as_str() == p).count() <= 2);
    }
    assert!(
        w.scheduler
            .as_mut()
            .unwrap()
            .poll(Duration::ZERO)
            .want
            .is_empty()
    );
}

fn drain(w: &mut Swarm) {
    for _ in 0..6 {
        let s = w.scheduler.as_mut().unwrap();
        let plan = s.poll(Duration::ZERO);
        if plan.want.is_empty() {
            return;
        }
        // Deliver out of order, like a real swarm.
        for r in plan.want.into_iter().rev() {
            assert!(w.fetched.insert(r.index), "duplicate piece {}", r.index);
            assert!(s.verified(&r.peer, r.index));
            assert!(!s.verified(&r.peer, r.index), "duplicate response accepted");
        }
    }
}

#[when("I download all pieces from the swarm")]
fn download(w: &mut Swarm) {
    drain(w);
}

#[when("I download successive playback windows")]
fn playback(w: &mut Swarm) {
    for playhead in [0, 2, 4] {
        w.scheduler
            .as_mut()
            .unwrap()
            .set_mode(ScheduleMode::SequentialAhead {
                playhead,
                lookahead: 2,
            });
        drain(w);
        assert!(w.scheduler.as_ref().unwrap().window_ready());
    }
}

#[then("every piece is fetched once and the download is complete")]
fn complete(w: &mut Swarm) {
    assert_eq!(w.fetched, (0..6).collect());
    assert!(w.scheduler.as_ref().unwrap().complete());
    assert!(
        w.scheduler
            .as_mut()
            .unwrap()
            .poll(Duration::from_secs(5))
            .want
            .is_empty()
    );
}

#[when("I seek from piece 0 to piece 4")]
fn seek(w: &mut Swarm) {
    let s = w.scheduler.as_mut().unwrap();
    s.set_mode(ScheduleMode::SequentialAhead {
        playhead: 0,
        lookahead: 2,
    });
    let old = s.poll(Duration::ZERO).want;
    assert_eq!(old.iter().map(|r| r.index).collect::<Vec<_>>(), [0, 1]);
    let cancel = s.set_mode(ScheduleMode::SequentialAhead {
        playhead: 4,
        lookahead: 2,
    });
    assert_eq!(cancel, old);
    for r in &old {
        assert!(!s.verified(&r.peer, r.index));
    }
    w.plan = s.poll(Duration::ZERO);
    w.plan.cancel = cancel;
}

#[then("the old requests are cancelled and pieces 4 and 5 are requested")]
fn sought(w: &mut Swarm) {
    assert_eq!(w.plan.cancel.len(), 2);
    assert_eq!(
        w.plan.want.iter().map(|r| r.index).collect::<Vec<_>>(),
        [4, 5]
    );
}

#[when("I move the window forward by one piece")]
fn overlap(w: &mut Swarm) {
    let s = w.scheduler.as_mut().unwrap();
    s.set_mode(ScheduleMode::SequentialAhead {
        playhead: 0,
        lookahead: 2,
    });
    let old = s.poll(Duration::ZERO).want;
    let cancel = s.set_mode(ScheduleMode::SequentialAhead {
        playhead: 1,
        lookahead: 2,
    });
    assert_eq!(cancel, vec![old[0].clone()]);
    assert!(s.is_requested(&old[1].peer, 1));
    w.plan = s.poll(Duration::ZERO);
}

#[then("the overlapping request stays active")]
fn overlaps(w: &mut Swarm) {
    assert_eq!(w.plan.want.iter().map(|r| r.index).collect::<Vec<_>>(), [2]);
}

#[when("a request for piece 0 times out")]
fn timeout(w: &mut Swarm) {
    let s = w.scheduler.as_mut().unwrap();
    s.set_mode(ScheduleMode::SequentialAhead {
        playhead: 0,
        lookahead: 1,
    });
    let old = s.poll(Duration::ZERO).want.remove(0);
    w.plan = s.poll(Duration::from_secs(1));
    assert_eq!(w.plan.cancel, [old.clone()]);
    assert_ne!(w.plan.want[0].peer, old.peer);
    assert!(!s.verified(&old.peer, 0));
}

#[then("the retry uses another peer and a late response is ignored")]
fn retried(w: &mut Swarm) {
    let r = &w.plan.want[0];
    assert!(w.scheduler.as_mut().unwrap().verified(&r.peer, r.index));
}

#[when("a peer disconnects with a pending request")]
fn disconnect(w: &mut Swarm) {
    let s = w.scheduler.as_mut().unwrap();
    s.set_mode(ScheduleMode::SequentialAhead {
        playhead: 0,
        lookahead: 1,
    });
    let old = s.poll(Duration::ZERO).want.remove(0);
    s.remove_peer(&old.peer);
    w.plan = s.poll(Duration::ZERO);
    assert_ne!(w.plan.want[0].peer, old.peer);
}

#[then("another peer supplies that piece")]
fn replaced(w: &mut Swarm) {
    retried(w);
}

#[tokio::main]
async fn main() {
    Swarm::cucumber()
        .fail_on_skipped()
        .run_and_exit("tests/features/p2p_scheduler.feature")
        .await;
}
