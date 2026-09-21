/// Adds two numbers.
///
/// ```
/// assert_eq!(probe_core::add(1, 2), 3);
/// ```
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

#[cfg(test)]
mod tests {
    #[test]
    fn core_adds() {
        assert_eq!(super::add(1, 2), 3);
    }
}
