fn interact(d) {
    d.show("Hello traveler! What brings you here?");
    d.add_option("Just passing through.", "node_1");
    d.add_option("Looking for work.", "node_2");
    return d;
}