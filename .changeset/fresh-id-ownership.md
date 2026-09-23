---
"effect-frame": patch
---

Predict a command whose ID the framework minted. `Generated.send` and `View.form` pass the ID they minted for one send, and that send now predicts at once, as a plain `send` does (#67 §3). An ID an application supplies, and an ID the server drew into a form's markup, still waits for its receipt. Not breaking.
