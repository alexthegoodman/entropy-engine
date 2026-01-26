export function interact(d) {
    let node = d.get_node();

    if (node === "" || node === "start") {
        d.show("Greetings, traveler. The winds are restless today.");
        d.add_option("They often are in these parts.", "weather");
        d.add_option("I seek information.", "info");
        d.add_option("Goodbye.", "end");
    }
    else if (node === "weather") {
        d.show("Indeed. A storm approaches from the north. Best be careful.");
        d.add_option("I will watch my step.", "start");
        d.add_option("I love storms.", "storm_lover");
        d.add_option("Can I help?", "start_quest");
    }
    else if (node === "start_quest") {
        d.show("You are brave. Talk to the Elder on the hill.");
        d.start_quest("storm_quest");
        d.add_option("I'm on it.", "end");
    }
    else if (node === "storm_lover") {
        d.show("A brave soul! Or perhaps a foolish one. Ha!");
        d.add_option("Back.", "weather");
    }
    else if (node === "info") {
        d.show("I know little of the world beyond this village. But the elder might know more.");
        d.add_option("Where is the elder?", "elder");
        d.add_option("Never mind.", "start");
    }
    else if (node === "elder") {
        d.show("He lives in the house on the hill. Can't miss it.");
        d.add_option("Thank you.", "start");
    }
    else if (node === "end") {
        d.close();
    }
    
    return d;
}
