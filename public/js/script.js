function setAfterConfirmMode() {
  // Hide everything
  const hideIds = [
    "actionButtonsBox",
    "aiControlsBox",
    "currentScheduleBox"
  ];

  hideIds.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.add("hidden");
  });

  // Show only new timetable
  const newBox = document.getElementById("newScheduleBox");
  if (newBox) newBox.classList.remove("hidden");
}
