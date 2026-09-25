---
"effect-frame": minor
---

`link(to, params, search)` accepts a `Source` of params as well as fixed
params (`LinkParams<Params>`). A layout that outlives a param move passes
`props.params`, so its links print and move with the params it holds now.
Before, a layout's links kept the tenant they were drawn with after a
tenant switch. The dashboard's header and range links now follow
`props.params`.
