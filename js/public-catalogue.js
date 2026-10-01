document.addEventListener("DOMContentLoaded", async () => {
  const container = document.getElementById("live-catalogue");
  if (!container) return;
  try {
    const response = await fetch("/api/offerings");
    if (!response.ok) throw new Error("The business catalogue is temporarily unavailable.");
    const { offerings } = await response.json();
    if (!offerings.length) return;
    const section = document.createElement("section");
    section.className = "special-offers";
    const heading = document.createElement("h3");
    heading.textContent = "Current guest-house services";
    section.append(heading);
    const list = document.createElement("div");
    list.className = "offers-grid";
    for (const offering of offerings) {
      const card = document.createElement("article");
      card.className = "offer-card";
      const details = document.createElement("div");
      details.className = "offer-details";
      const title = document.createElement("h3");
      title.textContent = offering.name;
      const description = document.createElement("p");
      description.textContent = offering.description || offering.category;
      const price = document.createElement("p");
      price.textContent = offering.price_cents == null
        ? "Contact us for pricing."
        : new Intl.NumberFormat("en-ZA", { style: "currency", currency: offering.currency })
          .format(offering.price_cents / 100);
      details.append(title, description, price);
      card.append(details);
      list.append(card);
    }
    section.append(list);
    const link = document.createElement("a");
    link.className = "btn gold-bg";
    link.href = "bookings.html#booking-form";
    link.textContent = "Request a booking";
    section.append(link);
    container.replaceChildren(section);
  } catch (error) {
    container.textContent = error.message;
  }
});
